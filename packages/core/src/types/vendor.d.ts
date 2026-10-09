// Minimal typings for untyped dependencies. Only what DraxMax uses is declared.

declare module 'magnet-uri' {
  export interface MagnetData {
    infoHash?: string;
    name?: string | string[];
    dn?: string | string[];
    announce?: string[];
    tr?: string | string[];
    urlList?: string[];
  }
  export function decode(uri: string): MagnetData;
  export function encode(data: MagnetData): string;
  const magnet: typeof decode;
  export default magnet;
}

declare module 'parse-torrent' {
  export interface ParsedTorrent {
    infoHash: string;
    name?: string;
    announce?: string[];
    urlList?: string[];
    length?: number;
    files?: { path: string; name: string; length: number; offset: number }[];
    pieceLength?: number;
    pieces?: string[];
    info?: unknown;
  }
  export default function parseTorrent(
    torrentId: string | Uint8Array | ParsedTorrent,
  ): Promise<ParsedTorrent>;
  export function toMagnetURI(parsed: ParsedTorrent): string;
  export function toTorrentFile(parsed: ParsedTorrent): Uint8Array;
}

declare module 'webtorrent' {
  import { EventEmitter } from 'node:events';

  export interface WebTorrentOptions {
    maxConns?: number;
    torrentPort?: number;
    dhtPort?: number;
    dht?: boolean | object;
    lsd?: boolean;
    utPex?: boolean;
    tracker?: boolean | object;
    webSeeds?: boolean;
    utp?: boolean;
    natUpnp?: boolean | 'permanent';
    natPmp?: boolean;
    secure?: number;
    downloadLimit?: number;
    uploadLimit?: number;
  }

  export interface TorrentAddOptions {
    path?: string;
    maxWebConns?: number;
    announce?: string[];
    paused?: boolean;
    deselect?: boolean;
    bitfield?: Uint8Array;
    skipVerify?: boolean;
    strategy?: 'sequential' | 'rarest';
    destroyStoreOnDestroy?: boolean;
  }

  export class TorrentFile extends EventEmitter {
    name: string;
    path: string;
    length: number;
    downloaded: number;
    progress: number;
    done: boolean;
    select(priority?: number): void;
    deselect(): void;
  }

  export interface TrackerClient extends EventEmitter {
    update(): void;
  }

  export interface Wire {
    remoteAddress?: string;
    remotePort?: number;
    type: string;
    isSeeder: boolean;
    peerId?: string;
    peerExtendedHandshake?: { v?: Uint8Array | string };
    peerPieces?: { get(i: number): boolean };
    downloadSpeed(): number;
    uploadSpeed(): number;
  }

  export class Torrent extends EventEmitter {
    infoHash: string;
    pieces: unknown[];
    discovery?: {
      tracker?: TrackerClient | null;
      dht?: unknown;
      _dhtAnnounce?: () => void;
    } | null;
    magnetURI: string;
    name: string;
    path: string;
    announce: string[];
    files: TorrentFile[];
    length: number;
    downloaded: number;
    uploaded: number;
    received: number;
    downloadSpeed: number;
    uploadSpeed: number;
    progress: number;
    timeRemaining: number;
    numPeers: number;
    ready: boolean;
    done: boolean;
    paused: boolean;
    destroyed: boolean;
    metadata: Uint8Array | null;
    torrentFile: Uint8Array;
    bitfield?: { buffer: Uint8Array };
    wires: Wire[];
    strategy: 'sequential' | 'rarest';
    pause(): void;
    resume(): void;
    destroy(opts?: { destroyStore?: boolean }, cb?: (err?: Error | null) => void): void;
  }

  export default class WebTorrent extends EventEmitter {
    constructor(opts?: WebTorrentOptions);
    static UTP_SUPPORT: boolean;
    torrents: Torrent[];
    destroyed: boolean;
    downloadSpeed: number;
    uploadSpeed: number;
    torrentPort: number;
    dht: { toJSON?: () => { nodes: unknown[] }; nodes?: { count(): number } } | false | null;
    add(torrentId: string | Uint8Array | object, opts?: TorrentAddOptions): Torrent;
    get(torrentId: string): Promise<Torrent | null>;
    throttleDownload(rate: number): void;
    throttleUpload(rate: number): void;
    destroy(cb?: (err?: Error | null) => void): void;
  }
}
