import { EventEmitter } from 'node:events';
import WebTorrent, { type Torrent, type TrackerClient, type Wire } from 'webtorrent';
import type { ParsedTorrent } from 'parse-torrent';
import type { FilePriority } from '@draxmax/shared';
import type {
  EngineAddOptions,
  EnginePeer,
  EngineTorrent,
  EngineTorrentEvents,
  EngineTorrentStats,
  EngineTrackerStats,
  TorrentEngine,
} from './engine.ts';
import { effectiveDhtPort, type Settings } from '../settings/settings.ts';
import { clientFromPeerId } from './peer-client.ts';
import { isUnsafeTorrentPath } from './sources.ts';

type EngineSettings = Pick<
  Settings,
  | 'torrentPort'
  | 'dhtPort'
  | 'maxConnections'
  | 'dht'
  | 'pex'
  | 'lsd'
  | 'upnp'
  | 'natPmp'
  | 'encryption'
  | 'downloadLimit'
  | 'uploadLimit'
>;

/**
 * {@link TorrentEngine} backed by a single WebTorrent client.
 *
 * WebTorrent destroys its whole client on some errors (TCP or DHT port in use) but only
 * degrades on others (uTP port in use just disables uTP). `onFatal` is called once when the
 * client is gone so the host can surface it and restart; recoverable errors go to `onWarning`.
 */
export class WebTorrentEngine implements TorrentEngine {
  private readonly client: WebTorrent;
  private fatal = false;
  private downloadedTotal = 0;
  private uploadedTotal = 0;

  constructor(
    settings: EngineSettings,
    hooks: { onFatal?: (err: Error) => void; onWarning?: (err: Error) => void } = {},
  ) {
    this.client = new WebTorrent({
      torrentPort: settings.torrentPort,
      dhtPort: effectiveDhtPort(settings),
      maxConns: settings.maxConnections,
      dht: settings.dht,
      lsd: settings.lsd,
      utPex: settings.pex,
      natUpnp: settings.upnp,
      natPmp: settings.natPmp,
      secure: settings.encryption,
      downloadLimit: settings.downloadLimit,
      uploadLimit: settings.uploadLimit,
    });
    // Torrent-level errors are routed to their own handlers; these are client-level.
    this.client.on('error', (raw: Error | string) => {
      const err = raw instanceof Error ? raw : new Error(String(raw));
      if (!this.client.destroyed) return hooks.onWarning?.(err);
      if (this.fatal) return;
      this.fatal = true;
      hooks.onFatal?.(err);
    });
    this.client.on('download', (bytes: number) => (this.downloadedTotal += bytes));
    this.client.on('upload', (bytes: number) => (this.uploadedTotal += bytes));
  }

  get downloadSpeed(): number {
    return this.client.downloadSpeed;
  }

  get uploadSpeed(): number {
    return this.client.uploadSpeed;
  }

  sessionTotals(): { downloaded: number; uploaded: number } {
    return { downloaded: this.downloadedTotal, uploaded: this.uploadedTotal };
  }

  dhtNodes(): number {
    const dht = this.client.dht;
    if (!dht) return 0;
    try {
      return dht.nodes?.count() ?? 0;
    } catch {
      return 0;
    }
  }

  add(source: string | ParsedTorrent, opts: EngineAddOptions): EngineTorrent {
    // A parsed torrent's own `announce` would be merged with `opts.announce`; replace it so
    // the tracker list is exactly what the manager asked for.
    const id = typeof source === 'string' ? source : { ...source, announce: [...opts.announce] };
    const torrent = this.client.add(id, {
      path: opts.savePath,
      bitfield: opts.bitfield,
      announce: typeof source === 'string' ? opts.announce : undefined,
      deselect: true,
      strategy: opts.sequential ? 'sequential' : 'rarest',
    });
    return new WebTorrentHandle(torrent, opts.announce);
  }

  setRateLimits(download: number, upload: number): void {
    this.client.throttleDownload(download);
    this.client.throttleUpload(upload);
  }

  destroy(): Promise<void> {
    if (this.client.destroyed) return Promise.resolve();
    return new Promise((resolve) => this.client.destroy(() => resolve()));
  }
}

/** Strips a trailing slash, the same normalisation bittorrent-tracker applies. */
function normalizeTracker(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

class WebTorrentHandle implements EngineTorrent {
  private readonly emitter = new EventEmitter();
  private readonly trackerState = new Map<string, EngineTrackerStats>();
  private hookedTracker: TrackerClient | null = null;

  constructor(
    private readonly torrent: Torrent,
    announce: string[],
  ) {
    for (const url of announce) {
      this.trackerState.set(normalizeTracker(url), { url, status: 'updating' });
    }
    // Attach to the tracker client as soon as WebTorrent creates it, before the first
    // announce completes; otherwise the initial status update would be missed.
    const internal = torrent as unknown as { _startDiscovery?: () => void };
    const startDiscovery = internal._startDiscovery?.bind(torrent);
    if (startDiscovery) {
      internal._startDiscovery = () => {
        startDiscovery();
        this.hookTracker();
      };
    }
    torrent.on('metadata', () => {
      // Magnets get their file list from peers: refuse paths that escape the save folder
      // before any piece can be written (pieces are only stored after download + hash check).
      if (torrent.files.some((f) => isUnsafeTorrentPath(f.path))) {
        torrent.destroy();
        this.emitter.emit('error', new Error('Torrent has file paths outside its folder; refused'));
        return;
      }
      this.emitter.emit('metadata');
    });
    torrent.on('ready', () => this.emitter.emit('ready'));
    torrent.on('error', (err: Error | string) =>
      this.emitter.emit('error', err instanceof Error ? err : new Error(String(err))),
    );
  }

  get infoHash(): string {
    return this.torrent.infoHash;
  }

  stats(): EngineTorrentStats {
    const t = this.torrent;
    const hasMetadata = t.metadata != null;
    return {
      name: hasMetadata ? t.name : null,
      totalSize: hasMetadata ? t.length : 0,
      downloaded: hasMetadata ? t.downloaded : 0,
      received: t.received,
      uploaded: t.uploaded,
      downloadSpeed: t.downloadSpeed,
      uploadSpeed: t.uploadSpeed,
      peers: t.numPeers,
      seeds: t.wires.filter((w) => w.isSeeder).length,
      hasMetadata,
      ready: t.ready,
      private: hasMetadata && (t as unknown as { private?: boolean }).private === true,
      files: t.files.map((f) => ({
        name: f.name,
        path: f.path,
        size: f.length,
        downloaded: Math.min(f.downloaded, f.length),
      })),
    };
  }

  trackers(): EngineTrackerStats[] {
    this.hookTracker();
    return [...this.trackerState.values()].map((t) => ({ ...t }));
  }

  /**
   * The tracker client is created lazily by WebTorrent (once the info-hash is known) and is
   * recreated when the listen port changes, so attach to whichever instance is current.
   */
  private hookTracker(): void {
    const tracker = this.torrent.discovery?.tracker ?? null;
    if (!tracker || tracker === this.hookedTracker) return;
    this.hookedTracker = tracker;
    tracker.on('update', (data: { announce: string; complete?: number; incomplete?: number }) => {
      const key = normalizeTracker(data.announce);
      const prev = this.trackerState.get(key);
      if (!prev) return;
      this.trackerState.set(key, {
        url: prev.url,
        status: 'working',
        seeders: data.complete,
        leechers: data.incomplete,
        lastAnnounce: new Date(),
      });
    });
    tracker.on('warning', (err: Error) => {
      const message = err?.message ?? String(err);
      for (const [key, state] of this.trackerState) {
        if (message.includes(key)) {
          this.trackerState.set(key, { ...state, status: 'not_working', message });
        }
      }
    });
  }

  peers(): EnginePeer[] {
    const pieceCount = this.torrent.pieces.length;
    return this.torrent.wires.map((w) => ({
      address: w.remoteAddress ? `${w.remoteAddress}:${w.remotePort ?? ''}` : (w.type ?? 'peer'),
      client: peerClient(w),
      type: w.type,
      progress: w.isSeeder ? 1 : pieceCount > 0 ? countPieces(w, pieceCount) / pieceCount : 0,
      downloadSpeed: w.downloadSpeed(),
      uploadSpeed: w.uploadSpeed(),
      seeder: w.isSeeder,
    }));
  }

  torrentFile(): Uint8Array | null {
    return this.torrent.metadata ? this.torrent.torrentFile : null;
  }

  bitfield(): Uint8Array | null {
    return this.torrent.bitfield ? new Uint8Array(this.torrent.bitfield.buffer) : null;
  }

  setFilePriorities(priorities: FilePriority[]): void {
    // Deselect everything first: files share boundary pieces, so interleaving
    // deselect/select would drop pieces belonging to an already-selected neighbour.
    for (const file of this.torrent.files) file.deselect();
    this.torrent.files.forEach((file, i) => {
      const p = priorities[i] ?? 1;
      if (p > 0) file.select(p);
    });
  }

  setSequential(sequential: boolean): void {
    // WebTorrent reads `strategy` on every piece pick, so this applies immediately.
    this.torrent.strategy = sequential ? 'sequential' : 'rarest';
  }

  reannounce(): void {
    const discovery = this.torrent.discovery;
    try {
      discovery?.tracker?.update();
      discovery?._dhtAnnounce?.();
    } catch {
      // Discovery not started yet; it announces on its own once it is.
    }
    for (const [key, state] of this.trackerState) {
      if (state.status !== 'working') this.trackerState.set(key, { ...state, status: 'updating' });
    }
  }

  on<E extends keyof EngineTorrentEvents>(
    event: E,
    listener: (...args: EngineTorrentEvents[E]) => void,
  ): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }

  destroy(): Promise<void> {
    return new Promise((resolve) => {
      if (this.torrent.destroyed) return resolve();
      this.torrent.destroy({ destroyStore: false }, () => resolve());
    });
  }
}

function countPieces(w: Wire, pieceCount: number): number {
  if (!w.peerPieces) return 0;
  let n = 0;
  for (let i = 0; i < pieceCount; i++) if (w.peerPieces.get(i)) n++;
  return n;
}

function peerClient(w: Wire): string {
  const v = w.peerExtendedHandshake?.v;
  if (v) return typeof v === 'string' ? v : new TextDecoder().decode(v);
  if (w.type === 'webSeed') return 'Web seed';
  return clientFromPeerId(w.peerId);
}
