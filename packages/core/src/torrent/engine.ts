import type { FilePriority } from '@draxmax/shared';
import type { ParsedTorrent } from 'parse-torrent';

/**
 * Engine abstraction. The manager only talks to this interface so the BitTorrent
 * implementation (currently WebTorrent) can be swapped or faked in tests.
 */
export interface TorrentEngine {
  /**
   * Starts a torrent from a magnet URI or a parsed `.torrent`. The torrent's tracker list is
   * exactly `opts.announce` (trackers embedded in the source are not added implicitly).
   */
  add(source: string | ParsedTorrent, opts: EngineAddOptions): EngineTorrent;
  /** Aggregate download speed in bytes/s. */
  readonly downloadSpeed: number;
  /** Aggregate upload speed in bytes/s. */
  readonly uploadSpeed: number;
  /** Network bytes received / sent since the engine started. */
  sessionTotals(): { downloaded: number; uploaded: number };
  /** Number of nodes in the DHT routing table (0 when DHT is disabled). */
  dhtNodes(): number;
  /** Applies global rate limits in bytes/s (-1 = unlimited). */
  setRateLimits(download: number, upload: number): void;
  /** Stops all torrents and releases sockets. */
  destroy(): Promise<void>;
}

export interface EngineAddOptions {
  savePath: string;
  /** Resume bitfield from a previous session; skips full re-hashing when valid. */
  bitfield?: Uint8Array | undefined;
  announce: string[];
  sequential: boolean;
}

export interface EngineFileStats {
  name: string;
  /** Path relative to the save path. */
  path: string;
  size: number;
  downloaded: number;
}

export interface EngineTrackerStats {
  url: string;
  status: 'working' | 'updating' | 'not_working';
  seeders?: number;
  leechers?: number;
  lastAnnounce?: Date;
  message?: string;
}

export interface EnginePeer {
  address: string;
  client: string;
  /** Connection type, e.g. tcpOutgoing, utpIncoming, webSeed. */
  type: string;
  /** Fraction of the torrent the peer has (0–1). */
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  seeder: boolean;
}

export interface EngineTorrentStats {
  name: string | null;
  totalSize: number;
  /** Verified bytes on disk. */
  downloaded: number;
  /** Bytes received from the network this session (including wasted). */
  received: number;
  /** Bytes uploaded this session. */
  uploaded: number;
  downloadSpeed: number;
  uploadSpeed: number;
  peers: number;
  seeds: number;
  hasMetadata: boolean;
  /** True once existing data has been verified and the torrent is transferring. */
  ready: boolean;
  files: EngineFileStats[];
}

export interface EngineTorrentEvents {
  metadata: [];
  ready: [];
  error: [Error];
}

export interface EngineTorrent {
  readonly infoHash: string;
  stats(): EngineTorrentStats;
  trackers(): EngineTrackerStats[];
  peers(): EnginePeer[];
  /** Raw `.torrent` bytes once metadata is known. */
  torrentFile(): Uint8Array | null;
  /** Current piece bitfield for fast resume, if metadata is known. */
  bitfield(): Uint8Array | null;
  /** Sets per-file priority; 0 deselects the file. Requires metadata. */
  setFilePriorities(priorities: FilePriority[]): void;
  setSequential(sequential: boolean): void;
  /** Announces to all trackers and the DHT now. */
  reannounce(): void;
  on<E extends keyof EngineTorrentEvents>(
    event: E,
    listener: (...args: EngineTorrentEvents[E]) => void,
  ): void;
  /** Stops the torrent. Never deletes data; the manager owns file deletion. */
  destroy(): Promise<void>;
}
