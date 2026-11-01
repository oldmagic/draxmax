/* eslint-disable no-control-regex -- IRC is built on control characters (CTCP \x01, mIRC colour codes). */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { APP_NAME, APP_VERSION, type XdccStatus, type XdccTransferDTO } from '@draxmax/shared';
import type { Database } from '../db/database.ts';
import { CoreError } from '../errors.ts';
import type { CoreEvents } from '../events.ts';
import type { Settings } from '../settings/settings.ts';
import { parseDccAccept, parseDccSend, receiveFile, safeFilename, type DccOffer } from './dcc.ts';
import { IrcClient, NetPolicyError, isSafeChannel, isSafeHost, isSafeNick } from './irc.ts';
import type { XdccPack } from './xdcc-info.ts';

/** A failure; `retry: false` when trying again can't help (no such pack, banned, …). */
export class XdccError extends Error {
  constructor(
    message: string,
    readonly retry = true,
  ) {
    super(message);
  }
}

export interface XdccDeps {
  db: Database;
  events: CoreEvents;
  settings: () => Settings;
  /** Allow IRC servers and DCC peers on local addresses (tests). */
  allowPrivate?: boolean;
  /** Pause after joining the bot's channel before asking it (bots often want a moment). */
  requestDelayMs?: number;
  retryDelayMs?: number;
  /** Give up when the bot hasn't sent or said anything for this long. */
  replyTimeoutMs?: number;
}

const MAX_ATTEMPTS = 5;
/** Once a bot says we're queued, wait this long for our turn. */
const QUEUED_TIMEOUT_MS = 12 * 3600_000;
const MAX_FILE = 2 ** 41; // 2 TiB

/** Bot replies that mean asking again won't work. */
const FATAL_REPLY =
  /invalid pack|no such pack|pack (?:\S+ )?(?:does ?n[o']?t|not) exist|denied|not allowed|banned|you must be (?:on|in)|only (?:voiced|ops|registered)|xdcc (?:is )?(?:disabled|off)|not (?:currently )?accepting/i;
/** Bot replies that mean we're waiting our turn. */
const QUEUED_REPLY = /queue|position|all slots (?:are )?(?:full|in use)/i;

interface Row {
  id: string;
  filename: string;
  network: string;
  host: string;
  port: number;
  tls: number;
  bot: string;
  channel: string | null;
  pack: number;
  size: number | null;
  received: number;
  status: XdccStatus;
  message: string | null;
  error: string | null;
  save_path: string;
  part_path: string | null;
  file_path: string | null;
  attempts: number;
  retry_at: number | null;
  created_at: string;
  completed_at: string | null;
}

interface Run {
  abort: AbortController;
  irc: IrcClient | null;
  /** Bytes at the previous tick, for the speed. */
  lastReceived: number;
  speed: number;
}

const ACTIVE: XdccStatus[] = ['connecting', 'requesting', 'downloading'];

/**
 * XDCC downloads: connects to the bot's IRC network, asks it for the pack, and receives the
 * file it offers over DCC. Transfers are kept in the database and resume after a restart or
 * a dropped connection (DCC RESUME). Each transfer uses its own short-lived IRC connection
 * under a random nick.
 */
export class XdccService {
  private readonly rows = new Map<string, Row>();
  private readonly running = new Map<string, Run>();
  private ticker: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private ticks = 0;

  constructor(private readonly deps: XdccDeps) {
    const rows = deps.db
      .prepare('SELECT * FROM xdcc_transfers ORDER BY created_at')
      .all() as unknown as Row[];
    for (const r of rows) {
      // Interrupted by a shutdown: carry on where it stopped.
      if (ACTIVE.includes(r.status)) r.status = 'queued';
      this.rows.set(r.id, r);
    }
  }

  /** Starts queued transfers and the retry timer. Calling it again just fills free slots. */
  start(): void {
    if (!this.retryTimer) {
      this.retryTimer = setInterval(() => this.pump(), 30_000);
      this.retryTimer.unref();
    }
    this.pump();
  }

  list(): XdccTransferDTO[] {
    return [...this.rows.values()].reverse().map((r) => this.dto(r));
  }

  activeCount(): number {
    return this.running.size;
  }

  add(pack: XdccPack, opts: { savePath?: string } = {}): XdccTransferDTO {
    if (
      !isSafeHost(pack.host) ||
      !isSafeNick(pack.bot) ||
      (pack.channel && !isSafeChannel(pack.channel))
    )
      throw new CoreError('invalid_input', 'This result has an invalid network, bot or channel');
    for (const r of this.rows.values())
      if (
        r.host === pack.host &&
        r.bot.toLowerCase() === pack.bot.toLowerCase() &&
        r.pack === pack.pack &&
        !['error', 'cancelled', 'completed'].includes(r.status)
      )
        throw new CoreError('conflict', 'This pack is already in the XDCC list');
    const s = this.deps.settings();
    const row: Row = {
      id: randomUUID(),
      filename: safeFilename(pack.filename, `pack-${pack.pack}`),
      network: pack.network,
      host: pack.host,
      port: pack.port,
      tls: pack.tls ? 1 : 0,
      bot: pack.bot,
      channel: pack.channel,
      pack: pack.pack,
      size: pack.size,
      received: 0,
      status: 'queued',
      message: null,
      error: null,
      save_path: opts.savePath || s.xdccDownloadPath || s.downloadPath,
      part_path: null,
      file_path: null,
      attempts: 0,
      retry_at: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    };
    this.rows.set(row.id, row);
    this.deps.db
      .prepare(
        `INSERT INTO xdcc_transfers (id, filename, network, host, port, tls, bot, channel, pack,
           size, received, status, save_path, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'queued', ?, 0, ?)`,
      )
      .run(
        row.id,
        row.filename,
        row.network,
        row.host,
        row.port,
        row.tls,
        row.bot,
        row.channel,
        row.pack,
        row.size,
        row.save_path,
        row.created_at,
      );
    this.changed();
    this.pump();
    return this.dto(row);
  }

  cancel(id: string): XdccTransferDTO {
    const r = this.get(id);
    if (['completed', 'cancelled'].includes(r.status)) return this.dto(r);
    const run = this.running.get(id);
    if (run) run.abort.abort();
    // A running one reports "cancelled" itself when its attempt ends.
    else this.update(r, { status: 'cancelled', retry_at: null });
    return this.dto(r);
  }

  retry(id: string): XdccTransferDTO {
    const r = this.get(id);
    if (!['error', 'cancelled'].includes(r.status))
      throw new CoreError('conflict', 'Only failed or cancelled transfers can be retried');
    this.update(r, { status: 'queued', error: null, message: null, attempts: 0, retry_at: null });
    this.pump();
    return this.dto(r);
  }

  /** Drops a transfer from the list; an unfinished file is deleted, a finished one only if asked. */
  remove(id: string, deleteFile = false): void {
    const r = this.get(id);
    this.running.get(id)?.abort.abort();
    this.rows.delete(id);
    this.deps.db.prepare('DELETE FROM xdcc_transfers WHERE id = ?').run(id);
    if (r.part_path) rmSync(r.part_path, { force: true });
    if (deleteFile && r.file_path) rmSync(r.file_path, { force: true });
    this.changed();
  }

  /** Ends running transfers; they resume on the next start. */
  stop(): void {
    this.stopping = true;
    if (this.retryTimer) clearInterval(this.retryTimer);
    if (this.ticker) clearInterval(this.ticker);
    for (const run of this.running.values()) {
      run.abort.abort();
      run.irc?.destroy();
    }
    for (const r of this.rows.values()) if (ACTIVE.includes(r.status)) this.persist(r);
  }

  // --- internals ---------------------------------------------------------------------

  private get(id: string): Row {
    const r = this.rows.get(id);
    if (!r) throw new CoreError('not_found', 'Transfer not found');
    return r;
  }

  private dto(r: Row): XdccTransferDTO {
    return {
      id: r.id,
      filename: r.filename,
      network: r.network,
      server: `${r.host}:${r.port}`,
      bot: r.bot,
      channel: r.channel,
      pack: r.pack,
      size: r.size,
      received: r.received,
      speed: this.running.get(r.id)?.speed ?? 0,
      status: r.status,
      message: r.message,
      error: r.error,
      savePath: r.save_path,
      filePath: r.file_path,
      attempts: r.attempts,
      createdAt: r.created_at,
      completedAt: r.completed_at,
    };
  }

  private changed(): void {
    this.deps.events.emit('xdcc:updated', null);
  }

  private persist(r: Row): void {
    this.deps.db
      .prepare(
        `UPDATE xdcc_transfers SET filename = ?, size = ?, received = ?, status = ?, message = ?,
           error = ?, part_path = ?, file_path = ?, attempts = ?, retry_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        r.filename,
        r.size,
        r.received,
        ACTIVE.includes(r.status) && this.stopping ? 'queued' : r.status,
        r.message,
        r.error,
        r.part_path,
        r.file_path,
        r.attempts,
        r.retry_at,
        r.completed_at,
        r.id,
      );
  }

  private update(r: Row, patch: Partial<Row>): void {
    Object.assign(r, patch);
    if (!this.rows.has(r.id)) return;
    this.persist(r);
    this.changed();
  }

  /** Starts queued transfers while there are free slots: one per bot at a time. */
  private pump(): void {
    if (this.stopping) return;
    const max = this.deps.settings().xdccMaxActive;
    const busy = new Set(
      [...this.running.keys()].map((id) => {
        const r = this.rows.get(id)!;
        return `${r.host}|${r.bot.toLowerCase()}`;
      }),
    );
    const now = Date.now();
    for (const r of this.rows.values()) {
      if (this.running.size >= max) break;
      if (r.status !== 'queued' || (r.retry_at && r.retry_at > now)) continue;
      const key = `${r.host}|${r.bot.toLowerCase()}`;
      if (busy.has(key)) continue;
      busy.add(key);
      void this.run(r);
    }
  }

  private tick = () => {
    for (const [id, run] of this.running) {
      const r = this.rows.get(id);
      if (!r) continue;
      run.speed = Math.max(0, r.received - run.lastReceived);
      run.lastReceived = r.received;
    }
    // Progress reaches the database every few seconds, not on every chunk.
    if (++this.ticks % 5 === 0)
      for (const id of this.running.keys()) {
        const r = this.rows.get(id);
        if (r) this.persist(r);
      }
    this.changed();
    if (this.running.size === 0 && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  };

  private async run(r: Row): Promise<void> {
    const run: Run = {
      abort: new AbortController(),
      irc: null,
      lastReceived: r.received,
      speed: 0,
    };
    this.running.set(r.id, run);
    if (!this.ticker) {
      this.ticker = setInterval(this.tick, 1000);
      this.ticker.unref();
    }
    this.update(r, { status: 'connecting', error: null, attempts: r.attempts + 1, retry_at: null });
    try {
      await this.attempt(r, run);
      const done = new Date().toISOString();
      this.update(r, { status: 'completed', completed_at: done, message: null, error: null });
      this.deps.events.emit('xdcc:done', this.dto(r));
    } catch (err) {
      const e = err as Error;
      if (this.stopping) {
        Object.assign(r, { status: 'queued' });
      } else if (run.abort.signal.aborted) {
        this.update(r, { status: 'cancelled', retry_at: null });
      } else if (
        (e instanceof XdccError ? e.retry : !(e instanceof NetPolicyError)) &&
        r.attempts < MAX_ATTEMPTS
      ) {
        const delay = (this.deps.retryDelayMs ?? 60_000) * r.attempts;
        this.update(r, {
          status: 'queued',
          error: null,
          message: `${e.message}. Trying again in ${Math.round(delay / 60_000) || 1} min`,
          retry_at: Date.now() + delay,
        });
      } else {
        this.update(r, { status: 'error', error: e.message, retry_at: null });
        this.deps.events.emit('xdcc:error', this.dto(r));
      }
    } finally {
      run.irc?.destroy();
      this.running.delete(r.id);
      this.changed();
      this.pump();
    }
  }

  private nick(): string {
    const fixed = this.deps.settings().xdccNick;
    if (fixed) return fixed;
    // Random and anonymous: nothing that identifies the install.
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const bytes = randomBytes(7);
    return (
      letters[bytes[0]! % 26]! + [...bytes.subarray(1)].map((b) => (b % 36).toString(36)).join('')
    );
  }

  /** One connect → ask → receive attempt. Resolves when the file is complete. */
  private attempt(r: Row, run: Run): Promise<void> {
    const signal = run.abort.signal;
    mkdirSync(r.save_path, { recursive: true });
    const irc = new IrcClient({
      host: r.host,
      port: r.port,
      tls: r.tls === 1,
      nick: this.nick(),
      version: `${APP_NAME} ${APP_VERSION}`,
      ...(this.deps.allowPrivate ? { allowPrivate: true } : {}),
    });
    run.irc = irc;
    const isBot = (nick: string) => nick.toLowerCase() === r.bot.toLowerCase();

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let downloading = false;
      let requested = false;
      let wait: NodeJS.Timeout | null = null;
      let pendingResume: {
        offer: DccOffer;
        size: number;
        part: string;
        position: number;
        timer: NodeJS.Timeout;
      } | null = null;

      const settle = (err: Error | null) => {
        if (settled) return;
        settled = true;
        if (wait) clearTimeout(wait);
        if (pendingResume) clearTimeout(pendingResume.timer);
        signal.removeEventListener('abort', onAbort);
        if (err) {
          irc.destroy();
          reject(err);
        } else {
          irc.quit('Thanks');
          resolve();
        }
      };
      const onAbort = () => settle(new Error('Cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });

      const waitFor = (ms: number, why: string) => {
        if (wait) clearTimeout(wait);
        wait = setTimeout(() => settle(new XdccError(why)), ms);
      };

      const request = () => {
        if (requested || settled) return;
        requested = true;
        this.update(r, { status: 'requesting', message: `Asked ${r.bot} for pack #${r.pack}` });
        irc.privmsg(r.bot, `XDCC SEND #${r.pack}`);
        waitFor(this.deps.replyTimeoutMs ?? 10 * 60_000, `${r.bot} did not answer`);
      };

      const download = (
        offer: DccOffer,
        size: number,
        part: string,
        offset: number,
        port = offer.port,
      ) => {
        downloading = true;
        if (wait) clearTimeout(wait);
        this.update(r, { status: 'downloading', message: null, received: offset });
        receiveFile({
          host: offer.host,
          port,
          path: part,
          offset,
          size,
          signal,
          ...(this.deps.allowPrivate ? { allowPrivate: true } : {}),
          onProgress: (total) => {
            r.received = total;
          },
        }).then(
          () => {
            const final = uniquePath(r.save_path, r.filename);
            renameSync(part, final);
            this.update(r, { part_path: null, file_path: final, received: size });
            settle(null);
          },
          (err: Error) => {
            this.persist(r);
            settle(
              err instanceof NetPolicyError
                ? new XdccError(`The bot offered a local network address (${offer.host})`, false)
                : new XdccError(err.message),
            );
          },
        );
      };

      const onOffer = (offer: DccOffer) => {
        if (offer.token !== null)
          return settle(
            new XdccError(
              `${r.bot} wants a passive (reverse) DCC connection, which DraxMax doesn't support`,
              false,
            ),
          );
        const size = offer.size ?? r.size;
        if (!size) return settle(new XdccError(`${r.bot} didn't say how big the file is`, false));
        if (size > MAX_FILE) return settle(new XdccError('The file is too large', false));
        const filename = safeFilename(offer.filename, r.filename);
        const part = r.part_path ?? join(r.save_path, `${filename}.part`);
        const have = existsSync(part) ? statSync(part).size : 0;
        // The free-space floor torrents respect applies here too.
        const floor = this.deps.settings().minFreeSpaceMb * 1024 * 1024;
        try {
          const fs = statfsSync(r.save_path);
          if (fs.bavail * fs.bsize < size - have + floor)
            return settle(new XdccError('Not enough free space on the drive', false));
        } catch {
          // Can't tell (some network shares): go ahead.
        }
        this.update(r, { filename, size, part_path: part });
        if (have > 0 && have < size) {
          // Ask the bot to continue where the last attempt stopped.
          const name = /[\s"]/.test(offer.filename)
            ? `"${offer.filename.replace(/"/g, '')}"`
            : offer.filename;
          const timer = setTimeout(() => {
            // No answer to the resume: start again from the beginning.
            pendingResume = null;
            download(offer, size, part, 0);
          }, 20_000);
          pendingResume = { offer, size, part, position: have, timer };
          irc.ctcp(r.bot, `DCC RESUME ${name.replace(/[\x00-\x1f]/g, '')} ${offer.port} ${have}`);
          this.update(r, { message: 'Resuming' });
        } else download(offer, size, part, 0);
      };

      irc.on('registered', () => {
        if (r.channel) {
          this.update(r, { message: `Joining ${r.channel}` });
          irc.send(`JOIN ${r.channel}`);
          // Ask anyway if the join never confirms.
          waitFor(30_000, `Could not join ${r.channel}`);
          setTimeout(() => {
            if (!requested && !settled) request();
          }, 20_000).unref();
        } else request();
      });
      irc.on('message', (m) => {
        if (requested) {
          // 401: no such nick.
          if (m.command === '401' && m.params[1] && isBot(m.params[1]))
            settle(new XdccError(`${r.bot} is not online right now`));
          return;
        }
        const delay = this.deps.requestDelayMs ?? 3000;
        if (m.command === '366' || (m.command === 'JOIN' && m.nick === irc.nick)) {
          if (wait) clearTimeout(wait);
          setTimeout(request, delay).unref();
        } else if (['403', '405', '471', '473', '474', '475', '477', '489'].includes(m.command)) {
          // Can't join (invite-only, banned, registered nicks only…): some bots answer anyway.
          this.update(r, { message: m.params.at(-1) ?? 'Could not join the channel' });
          if (wait) clearTimeout(wait);
          setTimeout(request, delay).unref();
        }
      });
      irc.on('notice', ({ from, text }) => {
        if (!isBot(from) || !text || downloading) return;
        this.update(r, { message: text.slice(0, 300) });
        if (FATAL_REPLY.test(text)) settle(new XdccError(`${r.bot}: ${text.slice(0, 200)}`, false));
        else if (QUEUED_REPLY.test(text))
          waitFor(QUEUED_TIMEOUT_MS, `Still queued at ${r.bot} after 12 hours`);
        else if (requested)
          waitFor(this.deps.replyTimeoutMs ?? 10 * 60_000, `${r.bot} did not send the file`);
      });
      irc.on('ctcp', ({ from, command, args }) => {
        if (command !== 'DCC' || !isBot(from) || !requested || downloading) return;
        const accept = parseDccAccept(args);
        if (accept && pendingResume) {
          const p = pendingResume;
          clearTimeout(p.timer);
          pendingResume = null;
          if (accept.position > 0 && accept.position <= p.position)
            download(p.offer, p.size, p.part, accept.position, accept.port || p.offer.port);
          else download(p.offer, p.size, p.part, 0);
          return;
        }
        const offer = parseDccSend(args);
        if (offer && !pendingResume) onOffer(offer);
      });
      irc.on('close', (err) => {
        // The file comes over its own connection; IRC may drop meanwhile.
        if (!downloading) settle(new XdccError(err?.message ?? 'Disconnected from IRC'));
      });

      irc
        .connect()
        .catch((err: Error) =>
          settle(
            err instanceof NetPolicyError ? err : new XdccError(`${r.network}: ${err.message}`),
          ),
        );
    });
  }
}

/** `name.ext`, or `name (2).ext` … when a file of that name is already there. */
function uniquePath(dir: string, name: string): string {
  let path = join(dir, name);
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; existsSync(path); i++) path = join(dir, `${stem} (${i})${ext}`);
  return path;
}
