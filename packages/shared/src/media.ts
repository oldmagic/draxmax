import type { LibraryEntry, UpcomingItem } from './models.ts';
import type { Wire } from './api.ts';

export type LibraryEntryDTO = Wire<LibraryEntry> & {
  /** Where the entry came from. */
  source: 'torrent' | 'folder' | 'manual';
  /** User removed it from the library fingerprint. */
  hidden: boolean;
};

export type UpcomingItemDTO = Wire<UpcomingItem> & {
  /** Why it is in "For You", e.g. "Next season of The Expanse". */
  reason?: string;
  /** Popularity on the source (TMDB popularity / AniList popularity). */
  popularity: number;
  /** Next episode/season number for series, if known. */
  season?: number;
  episode?: number;
  status?: 'upcoming' | 'airing' | 'released';
};

export interface UpcomingResponse {
  forYou: UpcomingItemDTO[];
  newReleases: UpcomingItemDTO[];
  /** ISO time of the last successful refresh. */
  updatedAt: string | null;
  sources: { tmdb: boolean; anilist: boolean };
  /** Human-readable problems from the last refresh (e.g. bad API key). */
  errors: string[];
  refreshing: boolean;
}

/** One followed show (an RSS rule with a save folder) checked for missing episodes. */
export interface MissingShowDTO {
  ruleId: string;
  ruleName: string;
  savePath: string;
  /** Show and season the folder holds, e.g. "Sousou no Frieren" / 2. */
  title: string | null;
  season: number | null;
  /** Episodes on disk, in the client or downloaded before. */
  have: number[];
  /** Released episodes (found by the search sources) that are not in `have`. */
  missing: number[];
  /** Episodes added to the client by the last check. */
  added: number[];
  /** Released episodes no acceptable release was found for (e.g. no seeders). */
  unavailable: number[];
  state: 'ok' | 'missing' | 'empty' | 'no-results' | 'error' | 'pending';
  /** Explanation for `empty`, `no-results` and `error`. */
  message: string | null;
  checkedAt: string | null;
  nextCheckAt: string | null;
}

export interface MissingResponse {
  enabled: boolean;
  shows: MissingShowDTO[];
  /** Enabled search sources, e.g. ["Nyaa", "AnimeTosho", "Torznab: prowlarr.lan"]. */
  sources: string[];
  running: boolean;
  /** Show currently being checked. */
  current: string | null;
  lastRunAt: string | null;
  /** Torrents added by the last run. */
  lastRunAdded: number;
  /** Enabled rules that can't be checked because they have no save folder. */
  noFolder: number;
  /** What happens for a folder without episodes (the global setting). */
  whenEmpty: 'wait' | 'download';
}
