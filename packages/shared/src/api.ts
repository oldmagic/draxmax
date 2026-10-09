import { z } from 'zod';
import type { DownloadRule, TorrentItem } from './models.ts';
import type { StatsSnapshot } from './stats.ts';
import type { NotificationDTO } from './notifications.ts';

/** Recursively converts `Date` fields to ISO strings, as they appear on the wire. */
export type Wire<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

export type TorrentDTO = Wire<TorrentItem>;

export const MAGNET_RE = /^magnet:\?/i;

/** POSIX (`/mnt/nas`), Windows drive (`D:\`) or UNC (`\\server\share`) absolute path. */
export function isAbsolutePath(p: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
}
const absolutePath = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine(isAbsolutePath, 'Must be an absolute path');

const addCommon = {
  savePath: absolutePath.optional(),
  paused: z.boolean().optional(),
  category: z.string().trim().max(100).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  sequential: z.boolean().optional(),
};

export const addMagnetSchema = z.object({
  magnetURI: z.string().trim().regex(MAGNET_RE, 'Not a magnet link').max(8192),
  ...addCommon,
});
export type AddMagnetRequest = z.infer<typeof addMagnetSchema>;

/** `.torrent` uploads are sent as base64 JSON so the same contract works over any transport. */
export const addTorrentFileSchema = z.object({
  fileName: z.string().max(512).optional(),
  data: z.base64().max(16 * 1024 * 1024),
  ...addCommon,
});
export type AddTorrentFileRequest = z.infer<typeof addTorrentFileSchema>;

export const removeTorrentSchema = z.object({
  deleteFiles: z.boolean().default(false),
});
export type RemoveTorrentRequest = z.infer<typeof removeTorrentSchema>;

export const setFilesSchema = z.object({
  files: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        priority: z.number().int().min(0).max(7),
      }),
    )
    .min(1),
});
export type SetFilesRequest = z.infer<typeof setFilesSchema>;

export interface HealthResponse {
  status: 'ok';
  version: string;
  uptime: number;
  torrents: number;
}

export interface ApiError {
  error: string;
  details?: unknown;
}

/** Server → client WebSocket messages. */
export type ServerEvent =
  | { type: 'torrents:snapshot'; torrents: TorrentDTO[] }
  | { type: 'torrent:added'; torrent: TorrentDTO }
  | { type: 'torrent:removed'; id: string }
  | { type: 'torrent:done'; id: string; name: string }
  | { type: 'torrent:seeded'; id: string; name: string; minutes: number }
  | { type: 'torrent:error'; id: string; name: string; error: string }
  | { type: 'rss:updated'; feedId: string | null }
  | { type: 'rss:match'; ruleName: string; title: string; status: 'added' | 'duplicate' }
  | { type: 'stats:tick'; stats: StatsSnapshot }
  | { type: 'upcoming:updated' }
  | { type: 'missing:updated' }
  | { type: 'sites:updated' }
  | { type: 'notifications:updated'; unread: number; item: NotificationDTO | null };

// --- M2: torrent controls, trackers, categories, settings ---------------------

export const updateTorrentSchema = z.object({
  category: z.string().trim().max(100).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  sequential: z.boolean().optional(),
});
export type UpdateTorrentRequest = z.infer<typeof updateTorrentSchema>;

export const queueMoveSchema = z.object({ move: z.enum(['top', 'up', 'down', 'bottom']) });

export const trackerUrlsSchema = z.object({
  urls: z.array(z.string().trim().min(1).max(2048)).min(1).max(200),
});
export const trackerToggleSchema = z.object({ url: z.string().min(1), enabled: z.boolean() });

export const categorySchema = z.object({
  name: z.string().trim().min(1).max(100),
  savePath: absolutePath.nullable().optional(),
});
export interface CategoryDTO {
  name: string;
  savePath: string | null;
}

export interface PeerDTO {
  address: string;
  client: string;
  type: string;
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  seeder: boolean;
}

/** Settings as returned by the API: secrets are blanked and reported via `secretsSet`. */
export interface SettingsResponse {
  settings: Record<string, unknown>;
  /** Keys fixed by environment variables (read-only in the UI). */
  locked: string[];
  /** Keys that only apply after a restart. */
  restartKeys: string[];
  secretsSet: Record<string, boolean>;
  /** Effective DHT port (derived when not set explicitly). */
  effectiveDhtPort: number;
  /** Whether a Web UI login is configured (from settings or env). */
  authConfigured: boolean;
  identity: ProcessIdentity;
}

/** The OS account the server runs as. */
export interface ProcessIdentity {
  uid: number | null;
  gid: number | null;
  /** Names from the account database, when known. */
  user: string | null;
  group: string | null;
  docker: boolean;
  /** A changed "run as" setting takes effect on restart (Docker entrypoint or started as root). */
  canApply: boolean;
  /** POST /api/system/restart is available (a supervisor brings the process back). */
  canRestart: boolean;
}

// --- M3: RSS ------------------------------------------------------------------

export interface FeedDTO {
  id: string;
  url: string;
  title: string;
  enabled: boolean;
  /** Effective refresh interval (custom or the global default). */
  refreshIntervalMinutes: number;
  /** Custom interval, or null when following the global default. */
  customRefreshMinutes: number | null;
  lastFetched: string | null;
  lastError: string | null;
  nextFetchAt: string | null;
  unread: number;
  total: number;
}

export interface ArticleDTO {
  feedId: string;
  id: string;
  title: string;
  link: string;
  torrentURL: string | null;
  pubDate: string;
  size: number | null;
  isRead: boolean;
  matchedRuleIds: string[];
  /** Already sent to the download list (by a rule or manually). */
  downloaded: boolean;
}

export interface RuleDTO extends Wire<DownloadRule> {
  lastMatchAt: string | null;
}

export interface RssHistoryDTO {
  id: number;
  ruleId: string | null;
  ruleName: string | null;
  feedId: string;
  articleTitle: string;
  torrentId: string | null;
  status: 'added' | 'duplicate' | 'failed';
  error: string | null;
  createdAt: string;
}

export const feedCreateSchema = z.object({
  url: z.url({ protocol: /^https?$/ }).max(2048),
  refreshMinutes: z.number().int().min(5).max(1440).nullable().optional(),
});

export const feedPatchSchema = z.object({
  url: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .optional(),
  title: z.string().trim().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  refreshMinutes: z.number().int().min(5).max(1440).nullable().optional(),
});

const ruleText = z.array(z.string().max(500)).max(100);
export const ruleSchema = z.object({
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(10_000).default(0),
  mustContain: ruleText.default([]),
  mustNotContain: ruleText.default([]),
  useRegex: z.boolean().default(false),
  episodeFilter: z.string().trim().max(500).optional(),
  smartEpisodeFilter: z.boolean().default(false),
  ignoreSubsequentDays: z.number().int().min(0).max(365).optional(),
  assignedFeedIds: z.array(z.string()).max(500).default([]),
  category: z.string().trim().max(100).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
  savePath: z
    .string()
    .trim()
    .max(4096)
    .refine((p) => p === '' || isAbsolutePath(p), 'Must be an absolute path')
    .optional(),
  addPaused: z.boolean().default(false),
});
export type RuleInput = z.infer<typeof ruleSchema>;

/**
 * Feeds and rules as one editable JSON document. Rules name their feeds by URL (not id) so
 * the document reads and edits naturally; `id` is optional and lets a rule be renamed.
 */
export const rssConfigSchema = z.object({
  feeds: z
    .array(
      z.object({
        url: z.url({ protocol: /^https?$/ }).max(2048),
        title: z.string().trim().min(1).max(200).optional(),
        enabled: z.boolean().default(true),
        refreshMinutes: z.number().int().min(5).max(1440).nullable().default(null),
      }),
    )
    .max(1000),
  rules: z
    .array(
      ruleSchema.omit({ assignedFeedIds: true }).extend({
        id: z.string().min(1).max(100).optional(),
        /** Feed URLs; empty = every feed. */
        feeds: z.array(z.string().min(1).max(2048)).max(500).default([]),
      }),
    )
    .max(5000),
});
export type RssConfig = z.input<typeof rssConfigSchema>;
export type RssConfigInput = z.infer<typeof rssConfigSchema>;
export const rssConfigSaveSchema = rssConfigSchema.extend({
  /** Delete feeds and rules that aren't in the document. */
  removeMissing: z.boolean().default(false),
});
export interface RssConfigSaveResult {
  feeds: { created: number; updated: number; deleted: number };
  rules: { created: number; updated: number; deleted: number };
}

export const ruleIdsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(5000) });

/** Adds and removes feeds on several rules at once. */
export const ruleFeedsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(5000),
  add: z.array(z.string().min(1)).max(500).default([]),
  remove: z.array(z.string().min(1)).max(500).default([]),
  /** Turn on disabled rules that end up with at least one feed. */
  enable: z.boolean().default(false),
  /** Run changed rules against articles already in their feeds (may download a backlog). */
  applyToExisting: z.boolean().default(false),
});
export type RuleFeedsRequest = z.infer<typeof ruleFeedsSchema>;
export interface RuleFeedsResult {
  /** Rules whose feeds or enabled state changed. */
  updated: number;
  /** Rules turned on by `enable`. */
  enabled: number;
}

export const markReadSchema = z.object({
  feedId: z.string().optional(),
  articles: z
    .array(z.object({ feedId: z.string(), id: z.string() }))
    .max(5000)
    .optional(),
  read: z.boolean().default(true),
});

export const articleRefSchema = z.object({ feedId: z.string().min(1), id: z.string().min(1) });

/** Body of POST /api/rss/rules/import: a qBittorrent rules export (`{ "<rule name>": {…} }`). */
export const qbRuleImportSchema = z.object({
  rules: z.record(z.string(), z.unknown()),
  /** Add feeds the rules reference that aren't subscribed yet. */
  createMissingFeeds: z.boolean().default(true),
  /** Also download matching articles already in the feeds (off: only future articles). */
  applyToExisting: z.boolean().default(false),
});
export type QbRuleImportRequest = z.input<typeof qbRuleImportSchema>;

export interface RuleImportResult {
  created: number;
  updated: number;
  feedsCreated: number;
  /** Rules or feeds that couldn't be imported. */
  errors: { name: string; error: string }[];
  /** Imported, but with something the user should check. */
  warnings: { name: string; warning: string }[];
}

// --- Folder browser -------------------------------------------------------------

export interface DirListing {
  /** Absolute, normalised path of the listed folder. */
  path: string;
  /** Null at a filesystem root. */
  parent: string | null;
  /** Names of subfolders (hidden ones excluded), sorted. */
  dirs: string[];
  /** Space available to the server process, or null if unknown. */
  freeBytes: number | null;
  writable: boolean;
}

export const mkdirSchema = z.object({ path: absolutePath });
