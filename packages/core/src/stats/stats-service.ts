import { statfs } from 'node:fs/promises';
import type { StatsHistory, StatsSample, StatsSnapshot } from '@draxmax/shared';
import type { Database } from '../db/database.ts';
import type { CoreEvents } from '../events.ts';
import type { Settings } from '../settings/settings.ts';
import type { TorrentEngine } from '../torrent/engine.ts';
import type { TorrentManager } from '../torrent/manager.ts';

const LIVE_POINTS = 300;
const MINUTE = 60_000;
const RETENTION_MS = 7 * 24 * 3600_000;
const DISK_CACHE_MS = 10_000;

export interface StatsDeps {
  db: Database;
  engine: TorrentEngine;
  torrents: TorrentManager;
  events: CoreEvents;
  settings: () => Settings;
}

interface AllTime {
  downloaded: number;
  uploaded: number;
}

/**
 * Live and historical transfer statistics. Samples every second into a ring buffer,
 * aggregates per minute into SQLite (kept 7 days), and keeps all-time totals.
 */
export class StatsService {
  private readonly live: StatsSample[] = [];
  private minuteAcc = { down: 0, up: 0, n: 0, start: 0 };
  private timer: NodeJS.Timeout | null = null;
  private readonly startedAt = new Date();
  private allTimeBase: AllTime;
  private disk: { at: number; value: StatsSnapshot['disk'] } = { at: 0, value: null };
  private latest: StatsSnapshot | null = null;

  constructor(private readonly deps: StatsDeps) {
    const row = deps.db.prepare("SELECT value FROM kv WHERE key = 'stats.alltime'").get() as
      { value: string } | undefined;
    this.allTimeBase = row ? (JSON.parse(row.value) as AllTime) : { downloaded: 0, uploaded: 0 };
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
  }

  /** Persists totals; call on shutdown. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.flushMinute(true);
    this.saveAllTime();
  }

  private allTime(): AllTime {
    const s = this.deps.engine.sessionTotals();
    return {
      downloaded: this.allTimeBase.downloaded + s.downloaded,
      uploaded: this.allTimeBase.uploaded + s.uploaded,
    };
  }

  private saveAllTime(): void {
    this.deps.db
      .prepare(
        "INSERT INTO kv (key, value) VALUES ('stats.alltime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(this.allTime()));
  }

  /** Takes one sample; exposed for tests. */
  async tick(now = Date.now()): Promise<StatsSnapshot> {
    const snap = await this.snapshot(now);
    this.live.push({ t: now, down: snap.downloadSpeed, up: snap.uploadSpeed });
    if (this.live.length > LIVE_POINTS) this.live.shift();

    const minute = Math.floor(now / MINUTE) * MINUTE;
    if (this.minuteAcc.n > 0 && minute !== this.minuteAcc.start) this.flushMinute();
    if (this.minuteAcc.n === 0) this.minuteAcc.start = minute;
    this.minuteAcc.down += snap.downloadSpeed;
    this.minuteAcc.up += snap.uploadSpeed;
    this.minuteAcc.n++;

    this.latest = snap;
    this.deps.events.emit('stats:tick', snap);
    return snap;
  }

  private flushMinute(partial = false): void {
    const a = this.minuteAcc;
    if (a.n === 0) return;
    this.deps.db
      .prepare(
        'INSERT INTO stats_samples (t, down, up) VALUES (?, ?, ?) ON CONFLICT(t) DO UPDATE SET down = excluded.down, up = excluded.up',
      )
      .run(a.start, a.down / a.n, a.up / a.n);
    this.deps.db.prepare('DELETE FROM stats_samples WHERE t < ?').run(Date.now() - RETENTION_MS);
    if (!partial) this.saveAllTime();
    this.minuteAcc = { down: 0, up: 0, n: 0, start: 0 };
  }

  private async diskInfo(usedByTorrents: number): Promise<StatsSnapshot['disk']> {
    const path = this.deps.settings().downloadPath;
    if (Date.now() - this.disk.at > DISK_CACHE_MS || this.disk.value?.path !== path) {
      try {
        const fs = await statfs(path);
        this.disk = {
          at: Date.now(),
          value: { path, free: fs.bavail * fs.bsize, total: fs.blocks * fs.bsize, usedByTorrents },
        };
      } catch {
        this.disk = { at: Date.now(), value: null };
      }
    }
    return this.disk.value ? { ...this.disk.value, usedByTorrents } : null;
  }

  /** Current snapshot (computed fresh). */
  async snapshot(now = Date.now()): Promise<StatsSnapshot> {
    const list = this.deps.torrents.list();
    const count = (pred: (s: string) => boolean) => list.filter((t) => pred(t.status)).length;
    const trackers = { working: 0, updating: 0, notWorking: 0, disabled: 0 };
    for (const t of list) {
      for (const tr of t.trackers) {
        if (tr.status === 'working') trackers.working++;
        else if (tr.status === 'updating') trackers.updating++;
        else if (tr.status === 'not_working') trackers.notWorking++;
        else trackers.disabled++;
      }
    }
    const session = this.deps.engine.sessionTotals();
    const allTime = this.allTime();
    const down = list.reduce((s, t) => s + t.downloadSpeed, 0);
    const up = list.reduce((s, t) => s + t.uploadSpeed, 0);
    return {
      time: new Date(now).toISOString(),
      downloadSpeed: down,
      uploadSpeed: up,
      session: {
        ...session,
        ratio: session.downloaded > 0 ? session.uploaded / session.downloaded : 0,
        startedAt: this.startedAt.toISOString(),
      },
      allTime: {
        ...allTime,
        ratio: allTime.downloaded > 0 ? allTime.uploaded / allTime.downloaded : 0,
      },
      torrents: {
        total: list.length,
        downloading: count((s) => s === 'downloading' || s === 'metadata'),
        seeding: count((s) => s === 'seeding'),
        paused: count((s) => s === 'paused'),
        queued: count((s) => s === 'queued'),
        checking: count((s) => s === 'checking'),
        error: count((s) => s === 'error'),
      },
      peers: list.reduce((s, t) => s + t.peers, 0),
      seeds: list.reduce((s, t) => s + t.seeds, 0),
      dhtNodes: this.deps.engine.dhtNodes(),
      trackers,
      disk: await this.diskInfo(list.reduce((s, t) => s + t.downloaded, 0)),
      top: list
        .filter((t) => t.downloadSpeed + t.uploadSpeed > 0)
        .sort((a, b) => b.downloadSpeed + b.uploadSpeed - (a.downloadSpeed + a.uploadSpeed))
        .slice(0, 5)
        .map((t) => ({
          id: t.id,
          name: t.name,
          downloadSpeed: t.downloadSpeed,
          uploadSpeed: t.uploadSpeed,
        })),
    };
  }

  /** Latest snapshot from the ticker, or a fresh one. */
  async current(): Promise<StatsSnapshot> {
    return this.latest ?? this.snapshot();
  }

  history(range: 'live' | 'day'): StatsHistory {
    if (range === 'live') return { range, step: 1, samples: [...this.live] };
    const rows = this.deps.db
      .prepare('SELECT t, down, up FROM stats_samples WHERE t >= ? ORDER BY t')
      .all(Date.now() - 24 * 3600_000) as unknown as StatsSample[];
    return { range, step: 60, samples: rows };
  }
}
