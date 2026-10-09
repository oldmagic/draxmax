import type { FilePriority } from '@draxmax/shared';
import type { EngineFileStats } from '../torrent/engine.ts';
import type { Database } from './database.ts';

/** Persisted state of a torrent: everything needed to restore it after a restart. */
export interface TorrentRecord {
  id: string;
  infoHash: string;
  name: string;
  magnetURI: string | null;
  torrentFile: Uint8Array | null;
  savePath: string;
  paused: boolean;
  addedAt: string;
  completedAt: string | null;
  category: string | null;
  tags: string[];
  sequential: boolean;
  priority: number;
  filePriorities: FilePriority[];
  /** Trackers in announce order; disabled ones are kept but not announced to. */
  trackers: { url: string; enabled: boolean }[];
  /** Last known file list and progress, so stopped torrents can still be shown and deleted. */
  files: EngineFileStats[];
  bitfield: Uint8Array | null;
  /** Upload counted in previous sessions; the live session total is added on top. */
  uploadedBase: number;
  /** Network bytes received in previous sessions. */
  downloadedBase: number;
  totalSize: number;
  error: string | null;
  /** Time spent seeding (finished and running), across sessions. */
  seedingSeconds: number;
}

interface Row {
  id: string;
  info_hash: string;
  name: string;
  magnet_uri: string | null;
  torrent_file: Uint8Array | null;
  save_path: string;
  paused: number;
  added_at: string;
  completed_at: string | null;
  category: string | null;
  tags: string;
  sequential: number;
  priority: number;
  file_priorities: string;
  files: string;
  trackers: string;
  bitfield: Uint8Array | null;
  uploaded_base: number;
  downloaded_base: number;
  total_size: number;
  error: string | null;
  seeding_seconds: number;
}

function fromRow(r: Row): TorrentRecord {
  return {
    id: r.id,
    infoHash: r.info_hash,
    name: r.name,
    magnetURI: r.magnet_uri,
    torrentFile: r.torrent_file,
    savePath: r.save_path,
    paused: r.paused === 1,
    addedAt: r.added_at,
    completedAt: r.completed_at,
    category: r.category,
    tags: JSON.parse(r.tags) as string[],
    sequential: r.sequential === 1,
    priority: r.priority,
    filePriorities: JSON.parse(r.file_priorities) as FilePriority[],
    files: JSON.parse(r.files) as EngineFileStats[],
    trackers: JSON.parse(r.trackers) as TorrentRecord['trackers'],
    bitfield: r.bitfield,
    uploadedBase: r.uploaded_base,
    downloadedBase: r.downloaded_base,
    totalSize: r.total_size,
    error: r.error,
    seedingSeconds: r.seeding_seconds,
  };
}

function toParams(t: TorrentRecord) {
  return {
    id: t.id,
    info_hash: t.infoHash,
    name: t.name,
    magnet_uri: t.magnetURI,
    torrent_file: t.torrentFile,
    save_path: t.savePath,
    paused: t.paused ? 1 : 0,
    added_at: t.addedAt,
    completed_at: t.completedAt,
    category: t.category,
    tags: JSON.stringify(t.tags),
    sequential: t.sequential ? 1 : 0,
    priority: t.priority,
    file_priorities: JSON.stringify(t.filePriorities),
    files: JSON.stringify(t.files),
    trackers: JSON.stringify(t.trackers),
    bitfield: t.bitfield,
    uploaded_base: t.uploadedBase,
    downloaded_base: t.downloadedBase,
    total_size: t.totalSize,
    error: t.error,
    seeding_seconds: Math.floor(t.seedingSeconds),
  };
}

const COLUMNS = [
  'id',
  'info_hash',
  'name',
  'magnet_uri',
  'torrent_file',
  'save_path',
  'paused',
  'added_at',
  'completed_at',
  'category',
  'tags',
  'sequential',
  'priority',
  'file_priorities',
  'files',
  'trackers',
  'bitfield',
  'uploaded_base',
  'downloaded_base',
  'total_size',
  'seeding_seconds',
  'error',
] as const;

/** CRUD for the `torrents` table. */
export class TorrentRepository {
  private readonly upsertStmt;
  private readonly deleteStmt;
  private readonly allStmt;

  constructor(private readonly db: Database) {
    const cols = COLUMNS.join(', ');
    const vals = COLUMNS.map((c) => `:${c}`).join(', ');
    const updates = COLUMNS.filter((c) => c !== 'id')
      .map((c) => `${c} = excluded.${c}`)
      .join(', ');
    this.upsertStmt = db.prepare(
      `INSERT INTO torrents (${cols}) VALUES (${vals}) ON CONFLICT(id) DO UPDATE SET ${updates}`,
    );
    this.deleteStmt = db.prepare('DELETE FROM torrents WHERE id = ?');
    this.allStmt = db.prepare('SELECT * FROM torrents ORDER BY added_at');
  }

  /** Returns every persisted torrent, oldest first. */
  all(): TorrentRecord[] {
    return (this.allStmt.all() as unknown as Row[]).map(fromRow);
  }

  /** Inserts or fully replaces a record. */
  save(record: TorrentRecord): void {
    this.upsertStmt.run(toParams(record));
  }

  /** Persists several records in one transaction (periodic resume-data flush). */
  saveMany(records: TorrentRecord[]): void {
    this.db.exec('BEGIN');
    try {
      for (const r of records) this.upsertStmt.run(toParams(r));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Deletes a record by id. */
  delete(id: string): void {
    this.deleteStmt.run(id);
  }
}
