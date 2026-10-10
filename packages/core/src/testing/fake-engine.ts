import { EventEmitter } from 'node:events';
import type { ParsedTorrent } from 'parse-torrent';
import type { FilePriority } from '@draxmax/shared';
import { makeTorrentFile } from './bencode.ts';
import type {
  EngineAddOptions,
  EngineFileStats,
  EnginePeer,
  EngineTorrent,
  EngineTorrentEvents,
  EngineTorrentStats,
  EngineTrackerStats,
  TorrentEngine,
} from '../torrent/engine.ts';

/** Controllable in-memory torrent for tests. Drive it with `giveMetadata`, `verify`, `progress`. */
export class FakeTorrent implements EngineTorrent {
  readonly emitter = new EventEmitter();
  destroyed = false;
  sequential: boolean;
  reannounced = 0;
  priorities: FilePriority[] = [];
  trackerStats: EngineTrackerStats[];
  peerList: EnginePeer[] = [];
  state: EngineTorrentStats = {
    name: null,
    totalSize: 0,
    downloaded: 0,
    received: 0,
    uploaded: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    peers: 0,
    seeds: 0,
    hasMetadata: false,
    ready: false,
    private: false,
    files: [],
  };

  constructor(
    readonly source: string | ParsedTorrent,
    readonly opts: EngineAddOptions,
  ) {
    this.sequential = opts.sequential;
    this.trackerStats = opts.announce.map((url) => ({ url, status: 'updating' }));
  }

  get infoHash(): string {
    return typeof this.source === 'string' ? 'fake' : this.source.infoHash;
  }

  /** Simulates metadata arriving (from the .torrent or ut_metadata). */
  giveMetadata(name: string, files: { path: string; size: number }[]): void {
    this.state.name = name;
    this.state.hasMetadata = true;
    this.state.files = files.map((f): EngineFileStats => ({
      name: f.path.split('/').pop()!,
      path: f.path,
      size: f.size,
      downloaded: 0,
    }));
    this.state.totalSize = files.reduce((s, f) => s + f.size, 0);
    this.emitter.emit('metadata');
  }

  /** Simulates piece verification finishing. */
  verify(): void {
    this.state.ready = true;
    this.emitter.emit('ready');
  }

  /** Sets verified bytes for a file index. */
  progress(index: number, downloaded: number): void {
    const file = this.state.files[index]!;
    file.downloaded = downloaded;
    this.state.downloaded = this.state.files.reduce((s, f) => s + f.downloaded, 0);
  }

  /** Marks every file fully downloaded and verified. */
  complete(): void {
    this.verify();
    this.state.files.forEach((f, i) => this.progress(i, f.size));
  }

  fail(message: string): void {
    this.emitter.emit('error', new Error(message));
  }

  stats(): EngineTorrentStats {
    return { ...this.state, files: this.state.files.map((f) => ({ ...f })) };
  }

  trackers(): EngineTrackerStats[] {
    return this.trackerStats.map((t) => ({ ...t }));
  }

  peers(): EnginePeer[] {
    return this.peerList;
  }

  torrentFile(): Uint8Array | null {
    if (!this.state.hasMetadata) return null;
    // Real bencoded bytes so the manager can re-parse them on resume.
    return makeTorrentFile(
      this.state.name ?? 'fake',
      this.state.files.map((f) => ({ path: f.path.split('/').slice(1), length: f.size })),
    );
  }

  bitfield(): Uint8Array | null {
    return this.state.hasMetadata ? new Uint8Array([0xff]) : null;
  }

  setFilePriorities(priorities: FilePriority[]): void {
    this.priorities = [...priorities];
  }

  setSequential(sequential: boolean): void {
    this.sequential = sequential;
  }

  reannounce(): void {
    this.reannounced++;
  }

  on<E extends keyof EngineTorrentEvents>(
    event: E,
    listener: (...args: EngineTorrentEvents[E]) => void,
  ): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

/** {@link TorrentEngine} that records every added torrent instead of touching the network. */
export class FakeEngine implements TorrentEngine {
  readonly added: FakeTorrent[] = [];
  limits: [number, number] = [-1, -1];
  destroyed = false;
  downloadSpeed = 0;
  uploadSpeed = 0;
  totals = { downloaded: 0, uploaded: 0 };
  nodes = 0;

  add(source: string | ParsedTorrent, opts: EngineAddOptions): FakeTorrent {
    const t = new FakeTorrent(source, opts);
    this.added.push(t);
    return t;
  }

  /** Most recently added torrent. */
  get last(): FakeTorrent {
    const t = this.added.at(-1);
    if (!t) throw new Error('No torrent added');
    return t;
  }

  /** Torrents currently running (added and not destroyed). */
  get running(): FakeTorrent[] {
    return this.added.filter((t) => !t.destroyed);
  }

  sessionTotals() {
    return this.totals;
  }

  dhtNodes(): number {
    return this.nodes;
  }

  setRateLimits(download: number, upload: number): void {
    this.limits = [download, upload];
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}
