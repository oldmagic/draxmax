/**
 * Domain models (spec §5). Dates are `Date` inside the core and ISO strings on the wire;
 * see `Wire<T>` in `api.ts`.
 */

export type TorrentStatus =
  'downloading' | 'seeding' | 'paused' | 'queued' | 'error' | 'checking' | 'metadata';

export interface TorrentItem {
  id: string;
  infoHash: string;
  name: string;
  magnetURI?: string;
  torrentFilePath?: string;
  savePath: string;
  status: TorrentStatus;
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  downloaded: number;
  uploaded: number;
  ratio: number;
  eta: number | null;
  peers: number;
  seeds: number;
  totalSize: number;
  files: TorrentFile[];
  trackers: Tracker[];
  category?: string;
  tags: string[];
  addedAt: Date;
  completedAt?: Date;
  /** Seconds spent seeding (finished and running), across sessions. */
  seedingTime: number;
  sequentialDownload: boolean;
  priority: number;
  error?: string;
}

export interface Tracker {
  url: string;
  status: 'working' | 'updating' | 'not_working' | 'disabled';
  peers?: number;
  seeders?: number;
  leechers?: number;
  lastAnnounce?: Date;
  /** Last error/warning reported by the tracker. */
  message?: string;
}

export type FilePriority = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface TorrentFile {
  name: string;
  path: string;
  size: number;
  progress: number;
  /** 0 = do not download */
  priority: FilePriority;
  selected: boolean;
}

export interface RSSFeed {
  id: string;
  url: string;
  title: string;
  lastFetched?: Date;
  enabled: boolean;
  refreshIntervalMinutes: number;
  articles: RSSArticle[];
}

export interface RSSArticle {
  id: string;
  title: string;
  link: string;
  torrentURL?: string;
  pubDate: Date;
  isRead: boolean;
  matchedRuleIds: string[];
}

export interface DownloadRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  mustContain: string[];
  mustNotContain: string[];
  useRegex: boolean;
  episodeFilter?: string;
  smartEpisodeFilter: boolean;
  ignoreSubsequentDays?: number;
  assignedFeedIds: string[];
  category?: string;
  tags: string[];
  savePath?: string;
  addPaused: boolean;
}

export interface LibraryEntry {
  id: string;
  title: string;
  type: 'movie' | 'tv' | 'anime' | 'other';
  tmdbId?: number;
  anilistId?: number;
  seasonsOwned: number[];
  lastSeason?: number;
  year?: number;
}

export interface UpcomingItem {
  id: string;
  title: string;
  type: 'movie' | 'tv' | 'anime';
  posterUrl?: string;
  releaseDate?: string;
  overview?: string;
  relevanceScore: number;
  matchedLibraryEntries: string[];
  source: 'tmdb' | 'anilist';
  externalIds: Record<string, string | number>;
}
