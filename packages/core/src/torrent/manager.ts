import { randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import parseTorrent, { type ParsedTorrent } from 'parse-torrent';
import type {
  FilePriority,
  Tracker,
  TorrentFile,
  TorrentItem,
  TorrentStatus,
} from '@draxmax/shared';
import type { CategoryRepository } from '../db/category-repo.ts';
import type { TorrentRecord, TorrentRepository } from '../db/torrent-repo.ts';
import type { CoreEvents } from '../events.ts';
import { CoreError } from '../errors.ts';
import type { Settings } from '../settings/settings.ts';
import type {
  EngineFileStats,
  EnginePeer,
  EngineTorrent,
  EngineTorrentStats,
  TorrentEngine,
} from './engine.ts';
import { parseMagnet, parseTorrentFile } from './sources.ts';
import { deleteTorrentFiles } from './delete-files.ts';
import { moveTorrentFiles } from './move-files.ts';
import {
  isTrackerUrl,
  mergeTrackers,
  normalizeTrackerUrl,
  stripMagnetTrackers,
} from './trackers.ts';

/** Default file priority ("normal"), matching qBittorrent semantics where 0 = skip. */
const DEFAULT_PRIORITY: FilePriority = 1;
/** How often running torrents' resume data is flushed to the database. */
const PERSIST_INTERVAL_MS = 30_000;
/** How often completion and the download queue are checked. */
const TICK_INTERVAL_MS = 1_000;

export interface TorrentManagerDeps {
  repo: TorrentRepository;
  categories: CategoryRepository;
  engine: TorrentEngine;
  events: CoreEvents;
  settings: () => Settings;
}

/** Where a torrent came from (shown in the notification history). */
export type AddOrigin = 'manual' | 'rss' | 'missing' | 'watch' | 'api';

export interface AddOptions {
  /** Who added it, and for RSS / missing episodes the rule name. */
  origin?: AddOrigin | undefined;
  originDetail?: string | undefined;
  savePath?: string | undefined;
  paused?: boolean | undefined;
  category?: string | undefined;
  tags?: string[] | undefined;
  sequential?: boolean | undefined;
}

export interface TorrentPatch {
  category?: string | null | undefined;
  tags?: string[] | undefined;
  sequential?: boolean | undefined;
}

export type QueueMove = 'top' | 'up' | 'down' | 'bottom';

interface Entry {
  record: TorrentRecord;
  handle: EngineTorrent | null;
  /** Bumped on every stop so an in-flight async start can tell it was cancelled. */
  generation: number;
  starting: boolean;
  /** Parsed .torrent cache (parsing is async and only needed on start). */
  parsed: ParsedTorrent | null;
  /** Set during a forced recheck so completion doesn't re-announce "done". */
  rechecking: boolean;
  /** Being removed (seeding limit reached); skip further ticks. */
  removing?: boolean;
  /** Its files are being moved to another folder; it restarts afterwards. */
  moving?: boolean;
  /** What the last periodic flush saw, so unchanged torrents aren't rewritten. */
  savedSig?: string;
}

const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, '') === b.replace(/[\\/]+$/, '');

/**
 * Owns the torrent list: persistence, engine lifecycle, the download queue, and the mapping
 * from engine state to {@link TorrentItem} snapshots. Pausing fully stops the engine torrent
 * (WebTorrent's own pause only stops new connections) and keeps its resume bitfield.
 */
export class TorrentManager {
  private readonly entries = new Map<string, Entry>();
  private tickTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly deps: TorrentManagerDeps) {}

  /** Restores persisted torrents and starts background timers. */
  init(): void {
    for (const record of this.deps.repo.all()) {
      this.entries.set(record.id, this.newEntry(record));
    }
    this.normalizeQueue();
    this.schedule();
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    this.persistTimer = setInterval(() => {
      this.persistAll();
      void this.checkDiskSpace();
    }, PERSIST_INTERVAL_MS);
    this.tickTimer.unref();
    this.persistTimer.unref();
  }

  /** Adds a torrent from a magnet URI. Throws `conflict` if it already exists. */
  addMagnet(magnetURI: string, opts: AddOptions = {}): TorrentItem {
    const src = parseMagnet(magnetURI);
    return this.addRecord(
      this.newRecord(src.infoHash, src.name ?? src.infoHash, opts, src.announce, { magnetURI }),
      opts,
    );
  }

  /** Adds a torrent from raw `.torrent` bytes. Throws `conflict` if it already exists. */
  async addTorrentFile(data: Uint8Array, opts: AddOptions = {}): Promise<TorrentItem> {
    const src = await parseTorrentFile(data);
    return this.addRecord(
      this.newRecord(src.infoHash, src.name ?? src.infoHash, opts, src.announce, {
        torrentFile: data,
        totalSize: src.totalSize,
        files: src.files.map((f) => ({ ...f, downloaded: 0 })),
        filePriorities: src.files.map(() => DEFAULT_PRIORITY),
        private: src.private,
      }),
      opts,
    );
  }

  /** True if a torrent with this info-hash is already in the list. */
  hasInfoHash(infoHash: string): boolean {
    const h = infoHash.toLowerCase();
    return [...this.entries.values()].some((e) => e.record.infoHash === h);
  }

  /** Current snapshots of all torrents in queue order. */
  list(): TorrentItem[] {
    return this.ordered().map((e) => this.toItem(e));
  }

  /** How many torrents are in the list. */
  count(): number {
    return this.entries.size;
  }

  /** Snapshot of one torrent. Throws `not_found`. */
  get(id: string): TorrentItem {
    return this.toItem(this.entry(id));
  }

  /** Stops transfer and frees peers; data and resume state are kept. */
  async pause(id: string): Promise<TorrentItem> {
    const entry = this.entry(id);
    entry.record.paused = true;
    await this.stop(entry);
    this.schedule();
    return this.toItem(entry);
  }

  /** Restarts a paused or errored torrent (subject to the download queue). */
  resume(id: string): TorrentItem {
    const entry = this.entry(id);
    // Stopped by a seeding limit and started again on purpose: let it seed.
    if (entry.record.paused && entry.record.completedAt && this.seedLimitReached(entry))
      entry.record.seedExempt = true;
    entry.record.paused = false;
    entry.record.error = null;
    this.deps.repo.save(entry.record);
    this.schedule();
    return this.toItem(entry);
  }

  /**
   * Changes where a torrent's data lives. With `moveFiles` the files are moved there (a copy
   * when it's another drive); without it the new folder is checked for existing data. While
   * a download still sits in the "incomplete" folder, only its destination changes.
   */
  async setLocation(id: string, savePath: string, moveFiles = true): Promise<TorrentItem> {
    const entry = this.entry(id);
    const target = savePath.trim();
    if (!target) throw new CoreError('invalid_input', 'Choose a folder');
    if (entry.moving) throw new CoreError('conflict', 'This torrent is already being moved');
    const { record } = entry;
    if (record.completePath && !record.completedAt) {
      record.completePath = samePath(target, record.savePath) ? null : target;
      this.deps.repo.save(record);
      return this.toItem(entry);
    }
    record.completePath = null;
    if (samePath(target, record.savePath)) {
      this.deps.repo.save(record);
      return this.toItem(entry);
    }
    if (moveFiles) await this.relocate(entry, target);
    else {
      await this.stop(entry);
      record.savePath = target;
      record.bitfield = null;
      entry.rechecking = true;
      this.deps.repo.save(record);
      this.schedule();
    }
    return this.toItem(entry);
  }

  /** True while a torrent's files are being moved. */
  isMoving(id: string): boolean {
    return this.entries.get(id)?.moving === true;
  }

  /** Pauses every running torrent. */
  async pauseAll(): Promise<void> {
    for (const e of this.entries.values()) {
      if (e.record.paused) continue;
      e.record.paused = true;
      await this.stop(e);
    }
  }

  /** Resumes every paused torrent (errors are cleared; the queue still applies). */
  resumeAll(): void {
    for (const e of this.entries.values()) {
      if (!e.record.paused && !e.record.error) continue;
      e.record.paused = false;
      e.record.error = null;
      this.deps.repo.save(e.record);
    }
    this.schedule();
  }

  /** Removes a torrent, optionally deleting its downloaded files. */
  async remove(id: string, deleteFiles: boolean): Promise<void> {
    const entry = this.entry(id);
    await this.stop(entry, { persist: false });
    const files = entry.record.files.map((f) => f.path);
    this.entries.delete(id);
    this.deps.repo.delete(id);
    if (deleteFiles && files.length > 0) {
      await deleteTorrentFiles(entry.record.savePath, files);
    }
    this.deps.events.emit('torrent:removed', id);
    this.normalizeQueue();
    this.schedule();
  }

  /** Sets per-file priorities by index (0 = skip). Requires metadata. */
  setFilePriorities(id: string, changes: { index: number; priority: number }[]): TorrentItem {
    const entry = this.entry(id);
    const fileCount = this.currentFiles(entry).length;
    if (fileCount === 0) throw new CoreError('invalid_input', 'Torrent metadata is not known yet');
    const next = this.prioritiesFor(entry.record, fileCount);
    for (const { index, priority } of changes) {
      if (index >= fileCount) throw new CoreError('invalid_input', `No file at index ${index}`);
      next[index] = priority as FilePriority;
    }
    entry.record.filePriorities = next;
    // Selecting more files reopens a finished torrent.
    if (entry.record.completedAt && !this.isComplete(entry)) entry.record.completedAt = null;
    this.deps.repo.save(entry.record);
    if (entry.handle?.stats().hasMetadata) entry.handle.setFilePriorities(next);
    this.schedule();
    return this.toItem(entry);
  }

  /** Updates category, tags and/or sequential mode. */
  update(id: string, patch: TorrentPatch): TorrentItem {
    const entry = this.entry(id);
    const r = entry.record;
    if (patch.category !== undefined) r.category = this.ensureCategory(patch.category);
    if (patch.tags !== undefined) r.tags = normalizeTags(patch.tags);
    if (patch.sequential !== undefined) {
      r.sequential = patch.sequential;
      entry.handle?.setSequential(patch.sequential);
    }
    this.deps.repo.save(r);
    return this.toItem(entry);
  }

  /** Moves a torrent within the download queue. */
  moveInQueue(id: string, move: QueueMove): TorrentItem {
    const entry = this.entry(id);
    const order = this.ordered();
    const i = order.indexOf(entry);
    order.splice(i, 1);
    const target =
      move === 'top'
        ? 0
        : move === 'bottom'
          ? order.length
          : move === 'up'
            ? Math.max(0, i - 1)
            : Math.min(order.length, i + 1);
    order.splice(target, 0, entry);
    order.forEach((e, pos) => {
      if (e.record.priority !== pos) {
        e.record.priority = pos;
        this.deps.repo.save(e.record);
      }
    });
    this.schedule();
    return this.toItem(entry);
  }

  // --- Trackers ----------------------------------------------------------------

  /** Adds trackers to a torrent; invalid URLs are rejected, duplicates ignored. */
  async addTrackers(id: string, urls: string[]): Promise<TorrentItem> {
    const bad = urls.filter((u) => !isTrackerUrl(u));
    if (bad.length) throw new CoreError('invalid_input', `Invalid tracker URL: ${bad[0]}`);
    const entry = this.entry(id);
    const known = new Set(entry.record.trackers.map((t) => normalizeTrackerUrl(t.url)));
    const added = mergeTrackers(urls).filter((u) => !known.has(normalizeTrackerUrl(u)));
    if (added.length === 0) return this.toItem(entry);
    entry.record.trackers.push(...added.map((url) => ({ url, enabled: true })));
    return this.applyTrackerChange(entry);
  }

  /** Removes trackers (matched by normalised URL). */
  async removeTrackers(id: string, urls: string[]): Promise<TorrentItem> {
    const entry = this.entry(id);
    const drop = new Set(urls.map(normalizeTrackerUrl));
    entry.record.trackers = entry.record.trackers.filter(
      (t) => !drop.has(normalizeTrackerUrl(t.url)),
    );
    return this.applyTrackerChange(entry);
  }

  /** Enables or disables one tracker without forgetting it. */
  async setTrackerEnabled(id: string, url: string, enabled: boolean): Promise<TorrentItem> {
    const entry = this.entry(id);
    const key = normalizeTrackerUrl(url);
    const t = entry.record.trackers.find((x) => normalizeTrackerUrl(x.url) === key);
    if (!t) throw new CoreError('not_found', `Tracker ${url} not found on this torrent`);
    t.enabled = enabled;
    return this.applyTrackerChange(entry);
  }

  /** Announces to trackers and DHT immediately. */
  reannounce(id: string): TorrentItem {
    const entry = this.entry(id);
    entry.handle?.reannounce();
    return this.toItem(entry);
  }

  /** Discards resume data and re-verifies every piece on disk. */
  async recheck(id: string): Promise<TorrentItem> {
    const entry = this.entry(id);
    await this.stop(entry);
    entry.record.bitfield = null;
    entry.rechecking = true;
    this.deps.repo.save(entry.record);
    if (this.wantsToRun(entry)) await this.start(entry, { force: true });
    return this.toItem(entry);
  }

  /** Connected peers of a running torrent. */
  peers(id: string): EnginePeer[] {
    return this.entry(id).handle?.peers() ?? [];
  }

  /** Re-evaluates the queue (e.g. after `maxActiveDownloads` changed). */
  reschedule(): void {
    this.schedule();
  }

  /** Clears a category from every torrent using it (category deleted). */
  clearCategory(name: string): void {
    for (const e of this.entries.values()) {
      if (e.record.category === name) {
        e.record.category = null;
        this.deps.repo.save(e.record);
      }
    }
  }

  /** All distinct tags in use, sorted. */
  tags(): string[] {
    const set = new Set<string>();
    for (const e of this.entries.values()) for (const t of e.record.tags) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  /** Flushes resume data and stops the engine. Safe to call once on shutdown. */
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.persistTimer) clearInterval(this.persistTimer);
    this.persistAll();
    this.entries.clear();
    await this.deps.engine.destroy();
  }

  // ---------------------------------------------------------------------------

  private entry(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new CoreError('not_found', `Torrent ${id} not found`);
    return entry;
  }

  private newEntry(record: TorrentRecord): Entry {
    return {
      record,
      handle: null,
      generation: 0,
      starting: false,
      parsed: null,
      rechecking: false,
    };
  }

  /** Entries in queue order (priority ascending, then age). */
  private ordered(): Entry[] {
    return [...this.entries.values()].sort(
      (a, b) =>
        a.record.priority - b.record.priority || a.record.addedAt.localeCompare(b.record.addedAt),
    );
  }

  private normalizeQueue(): void {
    this.ordered().forEach((e, pos) => {
      if (e.record.priority !== pos) {
        e.record.priority = pos;
        this.deps.repo.save(e.record);
      }
    });
  }

  private ensureCategory(name: string | null | undefined): string | null {
    const n = name?.trim();
    if (!n) return null;
    if (n.length > 100) throw new CoreError('invalid_input', 'Category name is too long');
    if (!this.deps.categories.get(n)) this.deps.categories.save({ name: n, savePath: null });
    return n;
  }

  private newRecord(
    infoHash: string,
    name: string,
    opts: AddOptions,
    sourceTrackers: string[],
    extra: Partial<TorrentRecord>,
  ): TorrentRecord {
    const settings = this.deps.settings();
    const category = this.ensureCategory(opts.category);
    const categoryPath = category ? this.deps.categories.get(category)?.savePath : null;
    const own = mergeTrackers(sourceTrackers);
    const ownKeys = new Set(own.map(normalizeTrackerUrl));
    // Private torrents (BEP 27) must only announce to their own tracker. A magnet's flag
    // isn't known yet, so its defaults are marked and dropped again if it turns out private.
    const defaults =
      settings.addDefaultTrackers && !extra.private
        ? mergeTrackers(settings.defaultTrackers).filter(
            (u) => !ownKeys.has(normalizeTrackerUrl(u)),
          )
        : [];
    const finalPath = opts.savePath ?? categoryPath ?? settings.downloadPath;
    const incomplete = settings.incompletePath;
    const staged = incomplete !== '' && !samePath(incomplete, finalPath);
    const lastPos = Math.max(-1, ...[...this.entries.values()].map((e) => e.record.priority));
    return {
      id: randomUUID(),
      infoHash,
      name,
      magnetURI: null,
      torrentFile: null,
      savePath: staged ? incomplete : finalPath,
      completePath: staged ? finalPath : null,
      private: false,
      seedExempt: false,
      paused: opts.paused ?? false,
      addedAt: new Date().toISOString(),
      completedAt: null,
      category,
      tags: normalizeTags(opts.tags ?? []),
      sequential: opts.sequential ?? false,
      priority: lastPos + 1,
      filePriorities: [],
      files: [],
      trackers: [
        ...own.map((url) => ({ url, enabled: true })),
        ...defaults.map((url) => ({ url, enabled: true, auto: true })),
      ],
      bitfield: null,
      uploadedBase: 0,
      downloadedBase: 0,
      seedingSeconds: 0,
      totalSize: 0,
      error: null,
      ...extra,
    };
  }

  private addRecord(record: TorrentRecord, opts: AddOptions = {}): TorrentItem {
    for (const e of this.entries.values()) {
      if (e.record.infoHash === record.infoHash) {
        throw new CoreError('conflict', `"${e.record.name}" is already in the list`);
      }
    }
    const entry = this.newEntry(record);
    this.entries.set(record.id, entry);
    this.deps.repo.save(record);
    this.schedule();
    const item = this.toItem(entry);
    this.deps.events.emit('torrent:added', item, {
      origin: opts.origin ?? 'api',
      detail: opts.originDetail ?? null,
    });
    return item;
  }

  private wantsToRun(entry: Entry): boolean {
    return !entry.record.paused && !entry.record.error && !entry.moving;
  }

  /**
   * Starts and stops engine torrents to honour pause state and `maxActiveDownloads`.
   * Seeding torrents always run; incomplete ones run in queue order up to the limit.
   */
  private schedule(): void {
    if (this.closed) return;
    const max = this.deps.settings().maxActiveDownloads;
    const runnable = this.ordered().filter((e) => this.wantsToRun(e));
    const downloaders = runnable.filter((e) => !e.record.completedAt);
    const allowed = new Set(max === 0 ? downloaders : downloaders.slice(0, max));
    for (const e of runnable) {
      const run = e.record.completedAt != null || allowed.has(e);
      if (run && !e.handle && !e.starting) void this.start(e);
      if (!run && (e.handle || e.starting)) void this.stop(e);
    }
  }

  private async buildSource(entry: Entry): Promise<string | ParsedTorrent> {
    const { record } = entry;
    if (record.torrentFile) {
      entry.parsed ??= await parseTorrent(record.torrentFile);
      return entry.parsed;
    }
    if (record.magnetURI) return stripMagnetTrackers(record.magnetURI);
    throw new Error('No magnet link or torrent file stored');
  }

  private async start(entry: Entry, { force = false } = {}): Promise<void> {
    if (entry.handle || (entry.starting && !force)) return;
    const generation = entry.generation;
    entry.starting = true;
    try {
      const source = await this.buildSource(entry);
      // Cancelled (stopped/removed/shut down) while parsing.
      if (this.closed || generation !== entry.generation || !this.entries.has(entry.record.id))
        return;
      if (!this.wantsToRun(entry) || entry.handle) return;
      const { record } = entry;
      const handle = this.deps.engine.add(source, {
        savePath: record.savePath,
        bitfield: record.bitfield ?? undefined,
        announce: record.trackers.filter((t) => t.enabled).map((t) => t.url),
        sequential: record.sequential,
      });
      entry.handle = handle;
      handle.on('metadata', () => this.onMetadata(entry, handle));
      handle.on('error', (err) => {
        if (entry.handle === handle) this.fail(entry, err);
      });
      if (handle.stats().hasMetadata) this.onMetadata(entry, handle);
    } catch (err) {
      this.fail(entry, err as Error);
    } finally {
      entry.starting = false;
    }
  }

  private onMetadata(entry: Entry, handle: EngineTorrent): void {
    if (entry.handle !== handle) return;
    const { record } = entry;
    const stats = handle.stats();
    record.name = stats.name ?? record.name;
    record.totalSize = stats.totalSize;
    record.torrentFile ??= handle.torrentFile();
    record.files = stats.files;
    record.filePriorities = this.prioritiesFor(record, stats.files.length);
    handle.setFilePriorities(record.filePriorities);
    if (stats.private && !record.private) {
      record.private = true;
      const kept = record.trackers.filter((t) => !t.auto);
      if (kept.length !== record.trackers.length) {
        record.trackers = kept;
        // Restart so the engine stops announcing to the public trackers.
        void this.applyTrackerChange(entry);
        return;
      }
    }
    this.deps.repo.save(record);
  }

  /** Stops the torrent, moves its files to `target` and lets it start again from there. */
  private async relocate(entry: Entry, target: string): Promise<void> {
    const { record } = entry;
    entry.moving = true;
    try {
      await this.stop(entry);
      await moveTorrentFiles(
        record.savePath,
        target,
        record.files.map((f) => f.path),
      );
      record.savePath = target;
      this.deps.repo.save(record);
    } catch (err) {
      entry.moving = false;
      this.fail(
        entry,
        new Error(`Could not move the files to ${target}: ${(err as Error).message}`),
      );
      throw new CoreError('invalid_input', `Could not move the files: ${(err as Error).message}`);
    } finally {
      entry.moving = false;
    }
    this.schedule();
  }

  /** A finished download leaves the "incomplete" folder for its real save folder. */
  private async moveWhenDone(entry: Entry): Promise<void> {
    const target = entry.record.completePath;
    if (!target) return;
    try {
      await this.relocate(entry, target);
    } catch {
      return; // Reported on the torrent by relocate().
    }
    if (!this.entries.has(entry.record.id)) return;
    entry.record.completePath = null;
    this.deps.repo.save(entry.record);
    this.deps.events.emit('torrent:done', this.toItem(entry));
  }

  /** Category limits win over the global ones; 0 means no limit. */
  private seedLimitReached(entry: Entry, stats?: EngineTorrentStats): boolean {
    const { record } = entry;
    if (record.seedExempt) return false;
    const s = this.deps.settings();
    const cat = record.category ? this.deps.categories.get(record.category) : null;
    const minutes = cat?.seedMinutes ?? s.seedTimeLimitMinutes;
    const ratio = cat?.seedRatio ?? s.seedRatioLimit;
    if (minutes > 0 && record.seedingSeconds >= minutes * 60) return true;
    if (ratio <= 0) return false;
    const { wanted } = this.wantedBytes(record, this.currentFiles(entry, stats));
    return wanted > 0 && (record.uploadedBase + (stats?.uploaded ?? 0)) / wanted >= ratio;
  }

  /** Seeding limit reached: stop it, or drop it from the list (files are kept either way). */
  private async onSeedLimit(entry: Entry): Promise<void> {
    if (this.deps.settings().seedLimitAction === 'remove') return this.removeSeeded(entry);
    entry.record.paused = true;
    await this.stop(entry);
    this.deps.events.emit('torrent:seeded', this.toItem(entry), { removed: false });
    this.schedule();
  }

  /** Stops downloads on drives that are almost full, before writes start failing. */
  private async checkDiskSpace(): Promise<void> {
    const mb = this.deps.settings().minFreeSpaceMb;
    if (mb <= 0) return;
    const byPath = new Map<string, Entry[]>();
    for (const e of this.entries.values()) {
      if (!e.handle || e.record.completedAt || e.moving) continue;
      byPath.set(e.record.savePath, [...(byPath.get(e.record.savePath) ?? []), e]);
    }
    for (const [path, entries] of byPath) {
      const free = await statfs(path).then(
        (s) => s.bavail * s.bsize,
        () => null,
      );
      if (free === null || free >= mb * 1024 * 1024) continue;
      for (const e of entries)
        if (e.handle && !e.record.completedAt)
          this.fail(e, new Error(`Stopped: less than ${mb} MB free in ${path}`));
    }
  }

  /** Stops the engine torrent, folding session counters into the persisted totals. */
  private async stop(entry: Entry, { persist = true } = {}): Promise<void> {
    entry.generation++;
    entry.starting = false;
    const handle = entry.handle;
    if (handle) {
      this.captureResumeData(entry, handle);
      const stats = handle.stats();
      entry.record.uploadedBase += stats.uploaded;
      entry.record.downloadedBase += stats.received;
      entry.handle = null;
      await handle.destroy();
    }
    if (persist) this.deps.repo.save(entry.record);
  }

  /** Persists a tracker list change and restarts the torrent so the engine picks it up. */
  private async applyTrackerChange(entry: Entry): Promise<TorrentItem> {
    this.deps.repo.save(entry.record);
    if (entry.handle || entry.starting) {
      await this.stop(entry);
      await this.start(entry);
    }
    return this.toItem(entry);
  }

  private fail(entry: Entry, err: Error): void {
    entry.record.error = err.message;
    void this.stop(entry).then(() => {
      this.deps.events.emit('torrent:error', this.toItem(entry));
      this.schedule();
    });
  }

  private captureResumeData(entry: Entry, handle: EngineTorrent): void {
    const stats = handle.stats();
    // Only trust the bitfield after verification finished; mid-check it is incomplete.
    if (stats.ready) entry.record.bitfield = handle.bitfield();
    if (stats.hasMetadata) entry.record.files = stats.files;
    entry.record.torrentFile ??= handle.torrentFile();
  }

  /**
   * Flushes resume data of running torrents. Stopped ones were saved when they stopped, and
   * a running torrent that hasn't transferred anything since the last flush is skipped.
   */
  private persistAll(): void {
    const records: TorrentRecord[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.handle) continue;
      const s = entry.handle.stats();
      const sig = `${s.downloaded}|${s.received}|${s.uploaded}|${s.ready}|${Math.floor(entry.record.seedingSeconds / 300)}`;
      if (sig === entry.savedSig) continue;
      entry.savedSig = sig;
      this.captureResumeData(entry, entry.handle);
      records.push(this.withSessionCounters(entry));
    }
    if (records.length) this.deps.repo.saveMany(records);
  }

  /** A copy of the record whose counters include the live session, for persistence. */
  private withSessionCounters(entry: Entry): TorrentRecord {
    if (!entry.handle) return entry.record;
    const s = entry.handle.stats();
    return {
      ...entry.record,
      uploadedBase: entry.record.uploadedBase + s.uploaded,
      downloadedBase: entry.record.downloadedBase + s.received,
    };
  }

  private lastTickAt = Date.now();

  private tick(): void {
    let changed = false;
    const now = Date.now();
    // Clamp so a suspended machine or stalled event loop doesn't count as seeding.
    const elapsed = Math.min(Math.max(0, now - this.lastTickAt), 5 * TICK_INTERVAL_MS) / 1000;
    this.lastTickAt = now;
    for (const entry of this.entries.values()) {
      if (!entry.handle || entry.removing || entry.moving) continue;
      const stats = entry.handle.stats();
      if (this.status(entry, stats) === 'seeding') {
        entry.record.seedingSeconds += elapsed;
        if (entry.record.completedAt && this.seedLimitReached(entry, stats)) {
          void this.onSeedLimit(entry);
          continue;
        }
      }
      const ready = stats.ready;
      if (ready && entry.rechecking) {
        entry.rechecking = false;
        entry.record.completedAt = this.isComplete(entry, stats)
          ? (entry.record.completedAt ?? new Date().toISOString())
          : null;
        this.deps.repo.save(this.withSessionCounters(entry));
        changed = true;
        continue;
      }
      if (entry.record.completedAt || !ready || !this.isComplete(entry, stats)) continue;
      entry.record.completedAt = new Date().toISOString();
      this.captureResumeData(entry, entry.handle);
      this.deps.repo.save(this.withSessionCounters(entry));
      changed = true;
      if (entry.record.completePath) {
        void this.moveWhenDone(entry);
        continue;
      }
      this.deps.events.emit('torrent:done', this.toItem(entry));
    }
    // A finished download frees a queue slot.
    if (changed) this.schedule();
  }

  /** Seeding time limit reached: drop it from the list, keeping the files. */
  private async removeSeeded(entry: Entry): Promise<void> {
    entry.removing = true;
    const item = this.toItem(entry);
    try {
      await this.remove(entry.record.id, false);
      this.deps.events.emit('torrent:seeded', item, { removed: true });
    } catch {
      entry.removing = false;
    }
  }

  private prioritiesFor(record: TorrentRecord, fileCount: number): FilePriority[] {
    return Array.from(
      { length: fileCount },
      (_, i) => record.filePriorities[i] ?? DEFAULT_PRIORITY,
    );
  }

  /** Live file stats when the engine has metadata, otherwise the last persisted snapshot. */
  private currentFiles(entry: Entry, live = entry.handle?.stats()): EngineFileStats[] {
    return live?.hasMetadata ? live.files : entry.record.files;
  }

  /** All wanted (priority > 0) bytes are verified. */
  private isComplete(entry: Entry, stats?: EngineTorrentStats): boolean {
    const files = this.currentFiles(entry, stats);
    if (files.length === 0) return false;
    const { wanted, have } = this.wantedBytes(entry.record, files);
    return have >= wanted;
  }

  private wantedBytes(
    record: TorrentRecord,
    files: EngineFileStats[],
  ): { wanted: number; have: number } {
    let wanted = 0;
    let have = 0;
    files.forEach((f, i) => {
      if ((record.filePriorities[i] ?? DEFAULT_PRIORITY) === 0) return;
      wanted += f.size;
      have += f.downloaded;
    });
    return { wanted, have };
  }

  private trackerItems(entry: Entry): Tracker[] {
    const live = new Map(
      (entry.handle?.trackers() ?? []).map((t) => [normalizeTrackerUrl(t.url), t]),
    );
    return entry.record.trackers.map((t): Tracker => {
      if (!t.enabled) return { url: t.url, status: 'disabled' };
      const s = live.get(normalizeTrackerUrl(t.url));
      if (!s) return { url: t.url, status: 'updating' };
      const out: Tracker = { url: t.url, status: s.status };
      if (s.seeders !== undefined) out.seeders = s.seeders;
      if (s.leechers !== undefined) out.leechers = s.leechers;
      if (s.seeders !== undefined || s.leechers !== undefined)
        out.peers = (s.seeders ?? 0) + (s.leechers ?? 0);
      if (s.lastAnnounce) out.lastAnnounce = s.lastAnnounce;
      if (s.message) out.message = s.message;
      return out;
    });
  }

  private toItem(entry: Entry): TorrentItem {
    const { record, handle } = entry;
    const stats = handle?.stats();
    const uploaded = record.uploadedBase + (stats?.uploaded ?? 0);
    const downloadedNet = record.downloadedBase + (stats?.received ?? 0);

    const fileStats = this.currentFiles(entry, stats);
    const files: TorrentFile[] = fileStats.map((f, i) => {
      const priority = record.filePriorities[i] ?? DEFAULT_PRIORITY;
      return {
        name: f.name,
        path: f.path,
        size: f.size,
        progress: f.size > 0 ? f.downloaded / f.size : 1,
        priority,
        selected: priority > 0,
      };
    });
    const { wanted, have } = this.wantedBytes(record, fileStats);
    const progress = wanted > 0 ? have / wanted : record.completedAt ? 1 : 0;
    const downloaded = fileStats.reduce((sum, f) => sum + f.downloaded, 0);
    const downloadSpeed = stats?.downloadSpeed ?? 0;
    const eta =
      downloadSpeed > 0 && wanted > have ? Math.round((wanted - have) / downloadSpeed) : null;

    const item: TorrentItem = {
      id: record.id,
      infoHash: record.infoHash,
      name: record.name,
      savePath: record.completePath ?? record.savePath,
      status: this.status(entry, stats),
      progress: Math.min(1, progress),
      downloadSpeed,
      uploadSpeed: stats?.uploadSpeed ?? 0,
      downloaded,
      uploaded,
      ratio: downloadedNet > 0 ? uploaded / downloadedNet : 0,
      eta,
      peers: stats?.peers ?? 0,
      seeds: stats?.seeds ?? 0,
      totalSize: stats?.hasMetadata ? stats.totalSize : record.totalSize,
      files,
      trackers: this.trackerItems(entry),
      tags: record.tags,
      addedAt: new Date(record.addedAt),
      sequentialDownload: record.sequential,
      priority: record.priority,
      seedingTime: Math.floor(record.seedingSeconds),
    };
    if (record.magnetURI) item.magnetURI = record.magnetURI;
    if (record.category) item.category = record.category;
    if (record.completedAt) item.completedAt = new Date(record.completedAt);
    if (record.error) item.error = record.error;
    if (record.private) item.private = true;
    return item;
  }

  private status(entry: Entry, stats: EngineTorrentStats | undefined): TorrentStatus {
    if (entry.moving) return 'moving';
    if (entry.record.error) return 'error';
    if (entry.record.paused) return 'paused';
    if (!stats) {
      if (!entry.starting) return 'queued';
      return entry.record.torrentFile ? 'checking' : 'metadata';
    }
    if (!stats.hasMetadata) return 'metadata';
    if (!stats.ready) return 'checking';
    if (this.isComplete(entry, stats)) return 'seeding';
    return 'downloading';
  }
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0 && t.length <= 64))];
}
