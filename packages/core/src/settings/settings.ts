import { z } from 'zod';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isTrackerUrl } from '../torrent/trackers.ts';

/** A few long-running public trackers, offered as the default global list. */
export const PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
];

const trackerUrl = z.string().trim().refine(isTrackerUrl, 'Not a valid tracker URL');

/** Empty, a numeric id, or a POSIX-style account name. */
const ACCOUNT_RE = /^(|\d{1,10}|[A-Za-z_][A-Za-z0-9_.-]{0,31}\$?)$/;

export const settingsSchema = z
  .object({
    // --- Downloads ---------------------------------------------------------
    downloadPath: z.string().min(1),
    /** Torrents downloading at once (0 = unlimited); the rest wait as "queued". */
    maxActiveDownloads: z.number().int().min(0).max(1000).default(5),
    /** Remove a torrent from the list (files kept) after seeding this long. 0 = seed forever. */
    seedTimeLimitMinutes: z.number().int().min(0).max(525_600).default(0),
    /**
     * OS user/group DraxMax runs as and owns its files as (name or numeric id; '' = default).
     * Applied at startup by the Docker entrypoint, or when started as root.
     */
    runAsUser: z.string().trim().regex(ACCOUNT_RE, 'Not a user name or id').default(''),
    runAsGroup: z.string().trim().regex(ACCOUNT_RE, 'Not a group name or id').default(''),
    /** Numeric ids resolved from the two above by the server (read by the entrypoint). */
    runAsUid: z.number().int().min(0).optional(),
    runAsGid: z.number().int().min(0).optional(),

    // --- Connection --------------------------------------------------------
    /** BitTorrent listen port (TCP + uTP over UDP). 0 = random. */
    torrentPort: z.number().int().min(0).max(65535).default(6881),
    /**
     * DHT UDP port. 0 = random. Defaults to `torrentPort + 1`: WebTorrent's uTP socket
     * already owns `torrentPort` on UDP, so the DHT cannot share it.
     */
    dhtPort: z.number().int().min(0).max(65535).optional(),
    maxConnections: z.number().int().min(1).max(2000).default(55),
    dht: z.boolean().default(true),
    pex: z.boolean().default(true),
    lsd: z.boolean().default(true),
    upnp: z.boolean().default(true),
    natPmp: z.boolean().default(true),
    /** 0 = disabled, 1 = prefer encrypted, 2 = require encrypted. */
    encryption: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(1),
    /** Bytes/s; -1 = unlimited. */
    downloadLimit: z.number().int().min(-1).default(-1),
    uploadLimit: z.number().int().min(-1).default(-1),

    // --- Trackers ----------------------------------------------------------
    defaultTrackers: z.array(trackerUrl).max(500).default(PUBLIC_TRACKERS),
    /** Append `defaultTrackers` to every newly added torrent. */
    addDefaultTrackers: z.boolean().default(false),

    // --- RSS ---------------------------------------------------------------
    rssEnabled: z.boolean().default(true),
    rssRefreshMinutes: z.number().int().min(5).max(1440).default(30),
    rssMaxArticlesPerFeed: z.number().int().min(10).max(5000).default(200),

    // --- Missing episodes ---------------------------------------------------
    /** Search for released episodes that RSS rules missed (gaps and newer episodes). */
    missingEnabled: z.boolean().default(true),
    /** How often followed (recently active) shows are checked; older shows weekly. */
    missingIntervalHours: z.number().int().min(1).max(168).default(6),
    missingUseNyaa: z.boolean().default(true),
    missingUseAnimeTosho: z.boolean().default(true),
    /** Torznab endpoints (Prowlarr/Jackett), including `apikey=`, separated by spaces or new lines. */
    torznabUrls: z.string().trim().max(16_384).default(''),
    /** Skip releases with fewer seeders (when the source reports them). */
    missingMinSeeders: z.number().int().min(0).max(1000).default(1),
    /** Cap on torrents added by one run, so a big backlog arrives in batches. */
    missingMaxPerRun: z.number().int().min(1).max(500).default(25),

    // --- Media intelligence ------------------------------------------------
    tmdbApiKey: z.string().trim().max(512).default(''),
    anilistEnabled: z.boolean().default(true),
    anilistToken: z.string().trim().max(4096).default(''),
    /** Extra folders scanned for the library fingerprint (besides torrents). */
    libraryFolders: z.array(z.string().min(1)).max(50).default([]),
    /** "Search & Add" target, e.g. `https://example.org/search?q={query}`. Empty = copy query. */
    searchUrlTemplate: z
      .string()
      .trim()
      .max(2048)
      .refine(
        (s) => s === '' || /^https?:\/\/.+\{query\}/.test(s),
        'Must be an http(s) URL containing {query}',
      )
      .default(''),

    // --- Automation --------------------------------------------------------
    /** Folder watched for .torrent / .magnet files. Empty = disabled. */
    watchPath: z.string().default(''),

    // --- Web UI / app --------------------------------------------------------
    webuiUsername: z.string().trim().max(128).default(''),
    /** scrypt hash (`scrypt$salt$hash`), never the password itself. */
    webuiPasswordHash: z.string().default(''),
    firstRunCompleted: z.boolean().default(false),
    logLevel: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    notifyOnComplete: z.boolean().default(true),
    notifyOnError: z.boolean().default(true),
    notifyOnRssMatch: z.boolean().default(true),
    /** Notification history: how long entries are kept, and which kinds are recorded. */
    notificationRetentionDays: z.number().int().min(1).max(3650).default(90),
    historyDownload: z.boolean().default(true),
    historyRss: z.boolean().default(true),
    historyUpcoming: z.boolean().default(true),
    historySecurity: z.boolean().default(true),
    historySystem: z.boolean().default(true),
    // Desktop only.
    closeToTray: z.boolean().default(true),
    startOnLogin: z.boolean().default(false),
    startMinimized: z.boolean().default(false),
  })
  .refine((s) => s.dhtPort === undefined || s.dhtPort === 0 || s.dhtPort !== s.torrentPort, {
    message: 'DHT port must differ from the torrent port (uTP already uses that UDP port)',
    path: ['dhtPort'],
  });
export type Settings = z.infer<typeof settingsSchema>;
export type SettingsKey = keyof Settings;

/** Keys whose change only takes effect after restarting the BitTorrent engine. */
export const RESTART_KEYS: SettingsKey[] = [
  'torrentPort',
  'dhtPort',
  'maxConnections',
  'dht',
  'pex',
  'lsd',
  'upnp',
  'natPmp',
  'encryption',
  'runAsUser',
  'runAsGroup',
];

/** Values encrypted at rest in settings.json and never returned by the API. */
export const SECRET_KEYS = ['tmdbApiKey', 'anilistToken', 'torznabUrls'] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

/** The DHT port actually used, applying the `torrentPort + 1` default. */
export function effectiveDhtPort(s: Pick<Settings, 'torrentPort' | 'dhtPort'>): number {
  if (s.dhtPort !== undefined) return s.dhtPort;
  return s.torrentPort === 0 ? 0 : Math.min(65535, s.torrentPort + 1);
}

type Kind = 'string' | 'int' | 'bool' | 'list';

/** Maps environment variables onto settings keys. Env always wins over the settings file. */
const ENV_MAP: Record<string, { key: SettingsKey; kind: Kind }> = {
  DOWNLOAD_PATH: { key: 'downloadPath', kind: 'string' },
  MAX_ACTIVE_DOWNLOADS: { key: 'maxActiveDownloads', kind: 'int' },
  TORRENT_PORT: { key: 'torrentPort', kind: 'int' },
  DHT_PORT: { key: 'dhtPort', kind: 'int' },
  MAX_CONNECTIONS: { key: 'maxConnections', kind: 'int' },
  ENABLE_DHT: { key: 'dht', kind: 'bool' },
  ENABLE_PEX: { key: 'pex', kind: 'bool' },
  ENABLE_LSD: { key: 'lsd', kind: 'bool' },
  ENABLE_UPNP: { key: 'upnp', kind: 'bool' },
  ENABLE_NATPMP: { key: 'natPmp', kind: 'bool' },
  ENCRYPTION: { key: 'encryption', kind: 'int' },
  DOWNLOAD_LIMIT: { key: 'downloadLimit', kind: 'int' },
  UPLOAD_LIMIT: { key: 'uploadLimit', kind: 'int' },
  DEFAULT_TRACKERS: { key: 'defaultTrackers', kind: 'list' },
  ADD_DEFAULT_TRACKERS: { key: 'addDefaultTrackers', kind: 'bool' },
  RSS_ENABLED: { key: 'rssEnabled', kind: 'bool' },
  RSS_REFRESH_MINUTES: { key: 'rssRefreshMinutes', kind: 'int' },
  MISSING_ENABLED: { key: 'missingEnabled', kind: 'bool' },
  MISSING_INTERVAL_HOURS: { key: 'missingIntervalHours', kind: 'int' },
  MISSING_USE_NYAA: { key: 'missingUseNyaa', kind: 'bool' },
  MISSING_USE_ANIMETOSHO: { key: 'missingUseAnimeTosho', kind: 'bool' },
  MISSING_MIN_SEEDERS: { key: 'missingMinSeeders', kind: 'int' },
  MISSING_MAX_PER_RUN: { key: 'missingMaxPerRun', kind: 'int' },
  TORZNAB_URLS: { key: 'torznabUrls', kind: 'string' },
  TMDB_API_KEY: { key: 'tmdbApiKey', kind: 'string' },
  ANILIST_ENABLED: { key: 'anilistEnabled', kind: 'bool' },
  ANILIST_TOKEN: { key: 'anilistToken', kind: 'string' },
  LIBRARY_FOLDERS: { key: 'libraryFolders', kind: 'list' },
  SEARCH_URL_TEMPLATE: { key: 'searchUrlTemplate', kind: 'string' },
  WATCH_PATH: { key: 'watchPath', kind: 'string' },
  WEBUI_USERNAME: { key: 'webuiUsername', kind: 'string' },
  LOG_LEVEL: { key: 'logLevel', kind: 'string' },
};

/** Extracts settings overrides from an environment object. Invalid values throw. */
export function envOverrides(env: NodeJS.ProcessEnv): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const [name, { key, kind }] of Object.entries(ENV_MAP)) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    if (kind === 'string') out[key] = raw;
    else if (kind === 'list') {
      out[key] = raw
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (kind === 'int') {
      const n = Number(raw);
      if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
      out[key] = n;
    } else {
      const v = raw.toLowerCase();
      if (!['1', '0', 'true', 'false', 'yes', 'no'].includes(v)) {
        throw new Error(`${name} must be a boolean, got "${raw}"`);
      }
      out[key] = ['1', 'true', 'yes'].includes(v);
    }
  }
  return out as Partial<Settings>;
}

/** Symmetric cipher for secrets at rest (AES key file on servers, OS keychain on desktop). */
export interface SecretCipher {
  encrypt(plain: string): string;
  decrypt(sealed: string): string;
}

const SEALED_PREFIX = 'enc:';

/**
 * Settings persisted as JSON in the config directory, with environment overrides layered on top.
 * Overridden keys are reported so the UI can show them as locked.
 */
export class SettingsStore {
  private fileSettings: Partial<Settings>;
  private readonly overrides: Partial<Settings>;
  private current: Settings;
  private readonly listeners = new Set<(s: Settings, changed: SettingsKey[]) => void>();

  constructor(
    private readonly filePath: string,
    private readonly defaults: Partial<Settings>,
    env: NodeJS.ProcessEnv = process.env,
    private readonly cipher: SecretCipher | null = null,
  ) {
    this.fileSettings = existsSync(filePath)
      ? this.unseal(JSON.parse(readFileSync(filePath, 'utf8')))
      : {};
    this.overrides = envOverrides(env);
    this.current = this.resolve();
  }

  private resolve(): Settings {
    return settingsSchema.parse({ ...this.defaults, ...this.fileSettings, ...this.overrides });
  }

  /** Current effective settings. */
  get(): Settings {
    return this.current;
  }

  /** Keys locked by environment variables. */
  lockedKeys(): SettingsKey[] {
    return Object.keys(this.overrides) as SettingsKey[];
  }

  /** Registers a change listener; returns an unsubscribe function. */
  onChange(fn: (s: Settings, changed: SettingsKey[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Validates and persists a partial update; returns the new effective settings. */
  update(patch: Partial<Settings>): Settings {
    // `undefined` clears a key back to its default.
    const next = Object.fromEntries(
      Object.entries({ ...this.fileSettings, ...patch }).filter(([, v]) => v !== undefined),
    ) as Partial<Settings>;
    // Validate the persisted layer on its own too, so an env override can't mask a bad value.
    settingsSchema.parse({ ...this.defaults, ...next });
    const before = this.current;
    this.fileSettings = next;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.seal(this.fileSettings), null, 2), { mode: 0o600 });
    renameSync(tmp, this.filePath);
    this.current = this.resolve();
    const changed = (Object.keys(this.current) as SettingsKey[]).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(this.current[k]),
    );
    if (changed.length > 0) for (const fn of this.listeners) fn(this.current, changed);
    return this.current;
  }

  private seal(s: Partial<Settings>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...s };
    for (const k of SECRET_KEYS) {
      const v = s[k];
      if (this.cipher && typeof v === 'string' && v !== '')
        out[k] = SEALED_PREFIX + this.cipher.encrypt(v);
    }
    return out;
  }

  private unseal(raw: Record<string, unknown>): Partial<Settings> {
    const out: Record<string, unknown> = { ...raw };
    for (const k of SECRET_KEYS) {
      const v = raw[k];
      if (typeof v !== 'string' || !v.startsWith(SEALED_PREFIX)) continue;
      try {
        out[k] = this.cipher ? this.cipher.decrypt(v.slice(SEALED_PREFIX.length)) : '';
      } catch {
        // Key file lost or rotated: drop the secret rather than failing startup.
        out[k] = '';
      }
    }
    return out as Partial<Settings>;
  }
}
