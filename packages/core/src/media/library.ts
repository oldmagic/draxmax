import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LibraryEntryDTO, TorrentItem } from '@draxmax/shared';
import type { Database } from '../db/database.ts';
import { parseRelease, titleKey } from './parse-title.ts';

export type LibraryType = 'movie' | 'tv' | 'anime' | 'other';

export interface LibraryRow {
  id: string;
  title: string;
  type: LibraryType;
  tmdbId: number | null;
  anilistId: number | null;
  seasonsOwned: number[];
  year: number | null;
  source: 'torrent' | 'folder' | 'manual';
  hidden: boolean;
  /** An external-ID lookup was attempted (successfully or not). */
  lookupDone: boolean;
  updatedAt: string;
}

const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|webm)$/i;
const SCAN_DEPTH = 3;
const MAX_SCAN_ENTRIES = 20_000;

/** Stable id for a title/type pair (movies include the year to keep remakes apart). */
export function libraryId(type: LibraryType, title: string, year?: number | null): string {
  return `${type}:${titleKey(title)}${type === 'movie' && year ? `:${year}` : ''}`;
}

function guessType(r: ReturnType<typeof parseRelease>): LibraryType {
  if (r.anime) return 'anime';
  if (r.season !== undefined || r.date) return 'tv';
  if (r.year) return 'movie';
  return 'other';
}

interface Candidate {
  title: string;
  type: LibraryType;
  year: number | null;
  seasons: Set<number>;
}

function addCandidate(map: Map<string, Candidate>, name: string): void {
  const r = parseRelease(name);
  if (!r.key || r.key.length < 2) return;
  const type = guessType(r);
  if (type === 'other') return;
  const id = libraryId(type, r.title, r.year);
  const c = map.get(id) ?? {
    title: r.title,
    type,
    year: r.year ?? null,
    seasons: new Set<number>(),
  };
  if (r.season !== undefined) c.seasons.add(r.season);
  map.set(id, c);
}

/** Recursively collects candidate names (folders and video files) under a directory. */
async function scanFolder(root: string, depth: number, out: string[]): Promise<void> {
  if (depth > SCAN_DEPTH || out.length > MAX_SCAN_ENTRIES) return;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      out.push(e.name);
      await scanFolder(join(root, e.name), depth + 1, out);
    } else if (VIDEO_EXT.test(e.name) && !/sample/i.test(e.name)) {
      out.push(e.name);
    }
  }
}

type Raw = Record<string, unknown>;

function fromRow(r: Raw): LibraryRow {
  return {
    id: r.id as string,
    title: r.title as string,
    type: r.type as LibraryType,
    tmdbId: (r.tmdb_id as number | null) ?? null,
    anilistId: (r.anilist_id as number | null) ?? null,
    seasonsOwned: JSON.parse(r.seasons_owned as string) as number[],
    year: (r.year as number | null) ?? null,
    source: r.source as LibraryRow['source'],
    hidden: r.hidden === 1,
    lookupDone: r.lookup_done === 1,
    updatedAt: r.updated_at as string,
  };
}

/**
 * The library "fingerprint": what the user already has, derived from torrent names,
 * optional media folders and manual "Already have" entries. External ids are kept
 * across rebuilds so lookups happen once per title.
 */
export class Library {
  constructor(private readonly db: Database) {}

  all(): LibraryRow[] {
    return (
      this.db.prepare('SELECT * FROM library_entries ORDER BY title COLLATE NOCASE').all() as Raw[]
    ).map(fromRow);
  }

  get(id: string): LibraryRow | null {
    const r = this.db.prepare('SELECT * FROM library_entries WHERE id = ?').get(id) as
      Raw | undefined;
    return r ? fromRow(r) : null;
  }

  save(e: LibraryRow): void {
    this.db
      .prepare(
        `INSERT INTO library_entries (id, title, type, tmdb_id, anilist_id, seasons_owned, year, source, hidden, lookup_done, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, type = excluded.type, tmdb_id = excluded.tmdb_id,
           anilist_id = excluded.anilist_id, seasons_owned = excluded.seasons_owned, year = excluded.year,
           source = excluded.source, hidden = excluded.hidden, lookup_done = excluded.lookup_done, updated_at = excluded.updated_at`,
      )
      .run(
        e.id,
        e.title,
        e.type,
        e.tmdbId,
        e.anilistId,
        JSON.stringify([...new Set(e.seasonsOwned)].sort((a, b) => a - b)),
        e.year,
        e.source,
        e.hidden ? 1 : 0,
        e.lookupDone ? 1 : 0,
        e.updatedAt,
      );
  }

  /** Adds (or merges into) a manual entry, e.g. from "Already have". */
  addManual(
    title: string,
    type: LibraryType,
    seasons: number[] = [],
    year: number | null = null,
    ids: { tmdbId?: number | null; anilistId?: number | null } = {},
  ): LibraryRow {
    const id = libraryId(type, title, year);
    const prev = this.get(id);
    const row: LibraryRow = {
      id,
      title: prev?.title ?? title,
      type,
      tmdbId: ids.tmdbId ?? prev?.tmdbId ?? null,
      anilistId: ids.anilistId ?? prev?.anilistId ?? null,
      seasonsOwned: [...(prev?.seasonsOwned ?? []), ...seasons],
      year: year ?? prev?.year ?? null,
      source: 'manual',
      hidden: false,
      lookupDone: prev?.lookupDone ?? false,
      updatedAt: new Date().toISOString(),
    };
    this.save(row);
    return row;
  }

  setHidden(id: string, hidden: boolean): LibraryRow | null {
    const row = this.get(id);
    if (!row) return null;
    row.hidden = hidden;
    row.updatedAt = new Date().toISOString();
    this.save(row);
    return row;
  }

  /**
   * Rebuilds automatically-derived entries from torrents and folders. Manual entries,
   * hidden flags and resolved external ids survive.
   */
  async rebuild(
    torrents: Pick<TorrentItem, 'name' | 'files'>[],
    folders: string[],
  ): Promise<LibraryRow[]> {
    const found = new Map<string, Candidate>();
    for (const t of torrents) {
      addCandidate(found, t.name);
      // Season packs often name episodes individually; their seasons count too.
      for (const f of t.files.slice(0, 200))
        if (VIDEO_EXT.test(f.name)) addCandidate(found, f.name);
    }
    const names: string[] = [];
    for (const folder of folders) await scanFolder(folder, 0, names);
    const folderIds = new Set<string>();
    for (const n of names) {
      const before = new Set(found.keys());
      addCandidate(found, n);
      for (const k of found.keys()) if (!before.has(k)) folderIds.add(k);
    }

    const existing = new Map(this.all().map((e) => [e.id, e]));
    const now = new Date().toISOString();
    this.db.exec('BEGIN');
    try {
      for (const [id, c] of found) {
        const prev = existing.get(id);
        this.save({
          id,
          title: prev?.title ?? c.title,
          type: c.type,
          tmdbId: prev?.tmdbId ?? null,
          anilistId: prev?.anilistId ?? null,
          seasonsOwned: [
            ...new Set([...(prev?.source === 'manual' ? prev.seasonsOwned : []), ...c.seasons]),
          ],
          year: c.year ?? prev?.year ?? null,
          source: prev?.source === 'manual' ? 'manual' : folderIds.has(id) ? 'folder' : 'torrent',
          hidden: prev?.hidden ?? false,
          lookupDone: prev?.lookupDone ?? false,
          updatedAt: now,
        });
        existing.delete(id);
      }
      // Derived entries that no longer exist are dropped; manual and hidden ones stay.
      for (const stale of existing.values()) {
        if (stale.source !== 'manual' && !stale.hidden)
          this.db.prepare('DELETE FROM library_entries WHERE id = ?').run(stale.id);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.all();
  }

  toDTO(e: LibraryRow): LibraryEntryDTO {
    const dto: LibraryEntryDTO = {
      id: e.id,
      title: e.title,
      type: e.type,
      seasonsOwned: e.seasonsOwned,
      source: e.source,
      hidden: e.hidden,
    };
    if (e.tmdbId != null) dto.tmdbId = e.tmdbId;
    if (e.anilistId != null) dto.anilistId = e.anilistId;
    if (e.seasonsOwned.length) dto.lastSeason = Math.max(...e.seasonsOwned);
    if (e.year != null) dto.year = e.year;
    return dto;
  }
}
