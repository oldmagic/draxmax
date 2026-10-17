import type { Dirent } from 'node:fs';
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
const MAX_SCAN_DIRS = 20_000;
/** A folder named for anime ("/media/Anime") types everything below it. */
const ANIME_PATH = /\banime\b/i;

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

function addCandidate(map: Map<string, Candidate>, name: string, animeHint = false): void {
  const r = parseRelease(name);
  if (!r.key || r.key.length < 2) return;
  // Inside an anime folder, anything with a season or episode is anime.
  const type = animeHint && (r.season !== undefined || !r.year) ? 'anime' : guessType(r);
  if (type === 'other') return;
  merge(map, r.title, type, r.year ?? null, r.season !== undefined ? [r.season] : []);
}

function merge(
  map: Map<string, Candidate>,
  title: string,
  type: LibraryType,
  year: number | null,
  seasons: Iterable<number>,
): void {
  const id = libraryId(type, title, year);
  const c = map.get(id) ?? { title, type, year, seasons: new Set<number>() };
  for (const s of seasons) c.seasons.add(s);
  map.set(id, c);
}

const SEASON_DIR = /^(?:season[ ._-]?|s)(\d{1,3})$/i;
/** "Universe.2021", "Fubar 2023", "The Rig (2023)": a show folder ending in its year. */
const TRAILING_YEAR = /^(.*\S)[ ._]\(?((?:19|20)\d{2})\)?$/;

const isVideo = (name: string) => VIDEO_EXT.test(name) && !/sample/i.test(name);

/** A show folder: the folder names the show, its contents only say which seasons exist. */
function addShow(
  map: Map<string, Candidate>,
  folder: string,
  anime: boolean,
  seasons: Iterable<number>,
): void {
  const y = TRAILING_YEAR.exec(folder);
  const year = y && Number(y[2]) <= new Date().getFullYear() + 2 ? Number(y[2]) : null;
  const r = parseRelease(year ? y![1]! : folder);
  if (!r.key || r.key.length < 2) return;
  merge(map, r.title, anime ? 'anime' : 'tv', year ?? r.year ?? null, seasons);
}

interface ScanState {
  /** Directories read so far (bounded by MAX_SCAN_DIRS). */
  dirs: number;
}

async function list(dir: string, state: ScanState): Promise<Dirent[]> {
  if (state.dirs++ > MAX_SCAN_DIRS) return [];
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith('.'));
  } catch {
    return [];
  }
}

/**
 * Collects titles under a media folder. Each child is one title: a show folder
 * ("Show/S01/…", or episodes directly inside), a release folder ("Movie.2019.1080p-GRP")
 * or a loose video file. Episode files never become titles of their own. A folder that is
 * none of these (say "Anime" or "Kids") is a grouping and is scanned the same way.
 */
async function scanFolder(
  root: string,
  depth: number,
  anime: boolean,
  out: Map<string, Candidate>,
  state: ScanState,
): Promise<void> {
  for (const e of await list(root, state)) {
    if (!e.isDirectory()) {
      if (isVideo(e.name)) addCandidate(out, e.name, anime);
      continue;
    }
    const path = join(root, e.name);
    const children = await list(path, state);
    const videos = children.filter((c) => !c.isDirectory() && isVideo(c.name)).map((c) => c.name);
    const seasonDirs = children.filter((c) => c.isDirectory() && SEASON_DIR.test(c.name));
    if (seasonDirs.length) {
      // Without a hint from the path, the episode names of one season tell anime from TV.
      const sample = anime
        ? []
        : (await list(join(path, seasonDirs[0]!.name), state)).map((c) => c.name).filter(isVideo);
      addShow(
        out,
        e.name,
        anime || looksAnime(sample),
        seasonDirs.map((d) => Number(SEASON_DIR.exec(d.name)![1])),
      );
      continue;
    }
    const self = parseRelease(e.name);
    if (guessType(self) !== 'other') {
      addCandidate(out, e.name, anime);
      continue;
    }
    const episodes = videos.map((v) => parseRelease(v)).filter((r) => r.season !== undefined);
    if (episodes.length) {
      addShow(
        out,
        e.name,
        anime || looksAnime(videos),
        episodes.map((r) => r.season!),
      );
    } else if (depth < SCAN_DEPTH) {
      await scanFolder(path, depth + 1, anime || ANIME_PATH.test(e.name), out, state);
    }
  }
}

/** Most of the names carry anime markers (fansub tag, absolute numbering). */
function looksAnime(names: string[]): boolean {
  const sample = names.slice(0, 20);
  return (
    sample.length > 0 && sample.filter((n) => parseRelease(n).anime).length * 2 > sample.length
  );
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

  /** Entries in use, and how many of them still await their first TMDB/AniList lookup. */
  progress(tmdb: boolean, anilist: boolean): { total: number; pending: number } {
    const row = this.db
      .prepare(
        `SELECT count(*) AS total, coalesce(sum(lookup_done = 0 AND (
           (? AND type IN ('tv', 'movie') AND tmdb_id IS NULL) OR
           (? AND type = 'anime' AND anilist_id IS NULL))), 0) AS pending
         FROM library_entries WHERE hidden = 0`,
      )
      .get(tmdb ? 1 : 0, anilist ? 1 : 0) as { total: number; pending: number };
    return { total: row.total, pending: row.pending };
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
    const inFolders = new Map<string, Candidate>();
    const state: ScanState = { dirs: 0 };
    for (const folder of folders)
      await scanFolder(folder, 0, ANIME_PATH.test(folder), inFolders, state);
    const folderIds = new Set<string>();
    for (const [id, c] of inFolders) {
      const prev = found.get(id);
      if (prev) for (const s of c.seasons) prev.seasons.add(s);
      else {
        found.set(id, c);
        folderIds.add(id);
      }
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
