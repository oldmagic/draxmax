import { mkdir, readFile, readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MAGNET_RE } from '@draxmax/shared';
import { CoreError } from '../errors.ts';
import type { CoreEvents } from '../events.ts';
import type { Settings } from '../settings/settings.ts';
import type { TorrentManager } from '../torrent/manager.ts';

const POLL_MS = 5_000;
/** A file must be unchanged for this long before it is picked up (still being copied otherwise). */
const SETTLE_MS = 2_000;

export interface WatchDeps {
  torrents: TorrentManager;
  events: CoreEvents;
  settings: () => Settings;
}

/**
 * Polls a folder for `.torrent` and `.magnet` files (a text file with one magnet link per line).
 * Polling rather than fs.watch, because bind mounts and network shares often don't deliver
 * change events. Handled files move to `.added/`, unusable ones to `.failed/`.
 */
const MAX_FILE_BYTES = 16 * 1024 * 1024;

export class WatchFolder {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Files we couldn't move (read-only folder): don't retry them every poll. */
  private readonly handled = new Set<string>();

  constructor(private readonly deps: WatchDeps) {}

  start(): void {
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One scan; exposed for tests. Returns the names of files handled. */
  async poll(now = Date.now()): Promise<string[]> {
    const dir = this.deps.settings().watchPath;
    if (!dir || this.running) return [];
    this.running = true;
    const done: string[] = [];
    try {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return [];
      }
      for (const name of names) {
        const lower = name.toLowerCase();
        if (!lower.endsWith('.torrent') && !lower.endsWith('.magnet')) continue;
        const path = join(dir, name);
        if (this.handled.has(path)) continue;
        try {
          const st = await stat(path);
          if (!st.isFile() || now - st.mtimeMs < SETTLE_MS) continue;
          // Real .torrent/.magnet files are small; don't read a huge file into memory.
          if (st.size > MAX_FILE_BYTES) {
            await this.moveAside(dir, name, '.failed');
            done.push(name);
            continue;
          }
          const ok = await this.ingest(path, lower.endsWith('.magnet'));
          await this.moveAside(dir, name, ok ? '.added' : '.failed');
          done.push(name);
        } catch {
          // Vanished mid-scan or unreadable: try again next poll.
        }
      }
    } finally {
      this.running = false;
    }
    return done;
  }

  private async ingest(path: string, isMagnet: boolean): Promise<boolean> {
    try {
      if (isMagnet) {
        const links = (await readFile(path, 'utf8'))
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => MAGNET_RE.test(l));
        if (links.length === 0) return false;
        for (const l of links) this.addSafely(() => this.deps.torrents.addMagnet(l));
        return true;
      }
      await this.deps.torrents.addTorrentFile(await readFile(path));
      return true;
    } catch (err) {
      // Already in the list counts as handled.
      return err instanceof CoreError && err.code === 'conflict';
    }
  }

  private addSafely(fn: () => unknown): void {
    try {
      fn();
    } catch (err) {
      if (!(err instanceof CoreError && err.code === 'conflict')) throw err;
    }
  }

  private async moveAside(dir: string, name: string, sub: string): Promise<void> {
    const target = join(dir, sub);
    try {
      await mkdir(target, { recursive: true });
      await rename(join(dir, name), join(target, `${Date.now()}-${name}`));
    } catch {
      this.handled.add(join(dir, name));
    }
  }
}
