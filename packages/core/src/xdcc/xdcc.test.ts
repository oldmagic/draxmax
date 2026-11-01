/* eslint-disable no-control-regex -- IRC is built on control characters (CTCP \x01, mIRC colour codes). */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../core.ts';
import { FakeEngine } from '../testing/index.ts';
import { parseDccAccept, parseDccSend, safeFilename } from './dcc.ts';
import { parseIrcLine, stripFormatting } from './irc.ts';
import { xdccInfoIndexer, type FetchJson } from './xdcc-info.ts';

describe('IRC and DCC parsing', () => {
  it('parses IRC lines', () => {
    expect(parseIrcLine(':Bot!b@host PRIVMSG me :\x01DCC SEND a.mkv 1 2 3\x01\r\n')).toEqual({
      prefix: 'Bot!b@host',
      nick: 'Bot',
      command: 'PRIVMSG',
      params: ['me', '\x01DCC SEND a.mkv 1 2 3\x01'],
    });
    expect(parseIrcLine('PING :irc.x')?.params).toEqual(['irc.x']);
    expect(parseIrcLine('@time=1 :s 001 me :Welcome')?.command).toBe('001');
    expect(stripFormatting('\x0304,01Queued\x03 \x02#2\x02')).toBe('Queued #2');
  });

  it('parses DCC offers in their usual forms', () => {
    expect(parseDccSend('SEND "My File.mkv" 3232235777 5000 1024')).toEqual({
      filename: 'My File.mkv',
      host: '192.168.1.1',
      port: 5000,
      size: 1024,
      token: null,
    });
    expect(parseDccSend('SEND file.bin 2130706433 6000')?.size).toBeNull();
    expect(parseDccSend('SEND two words.mkv 2130706433 6000 99')?.filename).toBe('two words.mkv');
    expect(parseDccSend('SEND f.mkv ::1 6000 10')?.host).toBe('::1');
    // Passive (reverse) DCC: port 0 and a token.
    expect(parseDccSend('SEND f.mkv 2130706433 0 10 77')?.token).toBe('77');
    expect(parseDccSend('SEND f.mkv notanip 6000 10')).toBeNull();
    expect(parseDccSend('CHAT chat 1 2')).toBeNull();
    expect(parseDccAccept('ACCEPT "a b.mkv" 5000 4096')).toEqual({ port: 5000, position: 4096 });
  });

  it('makes bot file names safe', () => {
    expect(safeFilename('../../etc/passwd', 'x')).toBe('passwd');
    expect(safeFilename('C:\\Windows\\evil.exe', 'x')).toBe('evil.exe');
    expect(safeFilename('..', 'pack-1')).toBe('pack-1');
    expect(safeFilename('.hidden', 'x')).toBe('hidden');
    expect(safeFilename('a\x00b|c?.mkv', 'x')).toBe('a_b_c_.mkv');
    expect(safeFilename('con.txt', 'x')).toBe('_con.txt');
    const long = safeFilename(`${'a'.repeat(400)}.mkv`, 'x');
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(200);
    expect(long.endsWith('.mkv')).toBe(true);
  });
});

describe('xdcc.info indexer', () => {
  it('maps results and takes port and TLS from the network list', async () => {
    const fetch = (async (url: string) => {
      if (url.endsWith('/api/v1/networks'))
        return [{ name: 'Rizon', address: 'irc.rizon.net', port: 6697, use_ssl: 1 }];
      expect(url).toBe('https://xdcc.info/api/v1/search?q=frieren%201080p&limit=100');
      return {
        results: [
          {
            pack_num: 42,
            filename: 'Frieren - 01 [1080p].mkv',
            filesize: 1000,
            gets: 5,
            bot: 'Bot|1',
            bot_channel: '#anime',
            network: 'Rizon',
            network_address: 'irc.rizon.net',
            last_seen: '2026-11-01 19:00:19',
          },
          // Unsafe values never reach an IRC command line.
          { pack_num: 1, filename: 'x', bot: 'bad nick', network_address: 'irc.x.net' },
          { pack_num: 1, filename: 'x', bot: 'ok', network_address: 'irc.x.net\r\nQUIT' },
        ],
      };
    }) as FetchJson;
    const packs = await xdccInfoIndexer('https://xdcc.info/', fetch).search('frieren 1080p');
    expect(packs).toEqual([
      {
        filename: 'Frieren - 01 [1080p].mkv',
        size: 1000,
        network: 'Rizon',
        host: 'irc.rizon.net',
        port: 6697,
        tls: true,
        bot: 'Bot|1',
        channel: '#anime',
        pack: 42,
        gets: 5,
        lastSeen: '2026-11-01T19:00:19.000Z',
        source: 'xdcc.info',
      },
    ]);
  });
});

/** A tiny IRC network with one bot that serves `file` for pack #7 over DCC. */
function fakeNetwork(file: Buffer, opts: { dropAfter?: number } = {}) {
  const log: string[] = [];
  let sends = 0;
  const dcc = net.createServer((sock) => {
    sends++;
    const start = resumeAt;
    const part =
      sends === 1 && opts.dropAfter ? file.subarray(start, opts.dropAfter) : file.subarray(start);
    sock.on('data', () => undefined); // acks
    sock.on('error', () => undefined);
    sock.write(part, () => (sends === 1 && opts.dropAfter ? sock.destroy() : undefined));
  });
  let resumeAt = 0;
  const irc = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let nick = '';
    let buf = '';
    const send = (l: string) => sock.write(`${l}\r\n`);
    sock.on('error', () => undefined);
    sock.on('data', (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        log.push(line);
        const [cmd, arg] = line.split(' ');
        if (cmd === 'NICK') nick = arg!;
        if (cmd === 'USER') send(`:irc.test 001 ${nick} :Welcome`);
        if (cmd === 'JOIN') {
          send(`:${nick}!u@h JOIN ${arg}`);
          send(`:irc.test 366 ${nick} ${arg} :End of /NAMES list.`);
        }
        const dccPort = (dcc.address() as net.AddressInfo).port;
        if (line === 'PRIVMSG Bot :XDCC SEND #7') {
          send(`:Bot!b@h NOTICE ${nick} :\x02Sending\x02 you pack #7`);
          send(
            `:Bot!b@h PRIVMSG ${nick} :\x01DCC SEND "../evil name.bin" 2130706433 ${dccPort} ${file.length}\x01`,
          );
        }
        if (line === 'PRIVMSG Bot :XDCC SEND #8')
          send(`:Bot!b@h NOTICE ${nick} :** Invalid Pack Number, Try Again`);
        const resume = /^PRIVMSG Bot :\x01DCC RESUME (.+) (\d+) (\d+)\x01$/.exec(line);
        if (resume) {
          resumeAt = Number(resume[3]);
          send(
            `:Bot!b@h PRIVMSG ${nick} :\x01DCC ACCEPT ${resume[1]} ${resume[2]} ${resume[3]}\x01`,
          );
        }
      }
    });
  });
  return {
    log,
    sends: () => sends,
    async listen() {
      await new Promise<void>((r) => irc.listen(0, '127.0.0.1', r));
      await new Promise<void>((r) => dcc.listen(0, '127.0.0.1', r));
      return (irc.address() as net.AddressInfo).port;
    },
    close() {
      irc.close();
      dcc.close();
    },
  };
}

describe('XDCC transfers', () => {
  let dir: string;
  let core: Core;
  let fake: ReturnType<typeof fakeNetwork> | null = null;
  let ircPort = 0;
  const file = randomBytes(300_000);

  const start = async (f: ReturnType<typeof fakeNetwork>) => {
    fake = f;
    ircPort = await f.listen();
    core = createCore({
      configPath: join(dir, 'config'),
      downloadPath: join(dir, 'dl'),
      engine: new FakeEngine(),
      noSchedulers: true,
      xdccAllowPrivate: true,
      env: {},
      xdccFetch: (async (url: string) =>
        url.endsWith('/networks')
          ? []
          : {
              results: [7, 8].map((pack) => ({
                pack_num: pack,
                filename: `Show - 0${pack}.mkv`,
                filesize: file.length,
                gets: pack,
                bot: 'Bot',
                bot_channel: '#chan',
                network: 'Test',
                network_address: '127.0.0.1',
              })),
            }) as FetchJson,
    });
    core.settings.update({
      minFreeSpaceMb: 0,
      missingUseNyaa: false,
      missingUseAnimeTosho: false,
      missingUseSubsPlease: false,
    });
    // Point the results at the fake network's port.
    const res = await core.search.search('show');
    return res.results
      .filter((r) => r.kind === 'xdcc')
      .sort((a, b) => a.xdcc!.pack - b.xdcc!.pack)
      .map((r) => {
        const hit = (
          core.search as unknown as { cache: Map<string, { pack: { port: number; tls: boolean } }> }
        ).cache.get(r.id)!;
        hit.pack.port = ircPort;
        hit.pack.tls = false;
        return r;
      });
  };

  const waitFor = async (id: string, statuses: string[]) => {
    for (let i = 0; i < 200; i++) {
      const t = core.xdcc.list().find((x) => x.id === id)!;
      if (statuses.includes(t.status)) return t;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out: ${JSON.stringify(core.xdcc.list().find((x) => x.id === id))}`);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'draxmax-xdcc-'));
  });
  afterEach(async () => {
    await core?.shutdown();
    fake?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists XDCC results with search and downloads a pack over DCC', async () => {
    const [r7] = await start(fakeNetwork(file));
    expect(r7!.xdcc).toMatchObject({ network: 'Test', bot: 'Bot', pack: 7 });
    expect(core.search.sourceList().find((s) => s.id === 'xdccinfo')?.enabled).toBe(true);
    (core.xdcc as unknown as { deps: { requestDelayMs: number } }).deps.requestDelayMs = 10;
    const t = core.search.addXdcc(r7!.id);
    core.xdcc.start();
    const done = await waitFor(t.id, ['completed', 'error']);
    expect(done.error).toBeNull();
    expect(done.status).toBe('completed');
    // The bot's "../evil name.bin" is kept inside the download folder.
    expect(done.filePath).toBe(join(dir, 'dl', 'evil name.bin'));
    expect(readFileSync(done.filePath!).equals(file)).toBe(true);
    expect(fake!.log).toContain('JOIN #chan');
    // A finished pack can be added again, but not while it's still in the list.
    expect(() => core.search.addXdcc(r7!.id)).not.toThrow();
    expect(() => core.search.addXdcc(r7!.id)).toThrow(/already/);
  });

  it('resumes after the bot drops the connection', async () => {
    const [r7] = await start(fakeNetwork(file, { dropAfter: 100_000 }));
    const x = core.xdcc as unknown as { deps: { requestDelayMs: number; retryDelayMs: number } };
    x.deps.requestDelayMs = 10;
    x.deps.retryDelayMs = 10;
    const t = core.search.addXdcc(r7!.id);
    core.xdcc.start();
    // The first attempt fails part-way and is queued for a retry with the partial file kept.
    await waitFor(t.id, ['queued']);
    await new Promise((r) => setTimeout(r, 50));
    core.xdcc.start();
    const done = await waitFor(t.id, ['completed', 'error']);
    expect(done.status).toBe('completed');
    expect(fake!.log.some((l) => l.includes('DCC RESUME'))).toBe(true);
    expect(readFileSync(done.filePath!).equals(file)).toBe(true);
    expect(existsSync(`${done.filePath}.part`)).toBe(false);
  });

  it('stops on a bot reply that retrying cannot fix', async () => {
    const [, r8] = await start(fakeNetwork(file));
    (core.xdcc as unknown as { deps: { requestDelayMs: number } }).deps.requestDelayMs = 10;
    const t = core.search.addXdcc(r8!.id);
    core.xdcc.start();
    const failed = await waitFor(t.id, ['error', 'completed']);
    expect(failed.status).toBe('error');
    expect(failed.error).toMatch(/Invalid Pack Number/);
    expect(failed.attempts).toBe(1);
  });

  it('refuses IRC servers on local addresses outside tests', async () => {
    const [r7] = await start(fakeNetwork(file));
    (core.xdcc as unknown as { deps: { allowPrivate: boolean } }).deps.allowPrivate = false;
    const t = core.search.addXdcc(r7!.id);
    core.xdcc.start();
    const failed = await waitFor(t.id, ['error', 'completed']);
    expect(failed.error).toMatch(/local network address/);
    expect(fake!.log).toHaveLength(0);
  });

  it('removes a transfer and its unfinished file', async () => {
    const [r7] = await start(fakeNetwork(file));
    const t = core.search.addXdcc(r7!.id);
    const part = join(dir, 'dl', 'x.part');
    writeFileSync(part, 'partial');
    (core.xdcc as unknown as { rows: Map<string, { part_path: string }> }).rows.get(
      t.id,
    )!.part_path = part;
    core.xdcc.remove(t.id);
    expect(existsSync(part)).toBe(false);
    expect(core.xdcc.list()).toHaveLength(0);
  });
});
