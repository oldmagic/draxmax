import { join } from 'node:path';
import { chmodSync, mkdirSync } from 'node:fs';
import { openDatabase, type Database } from './db/database.ts';
import { applyPendingRestore, createBackup, stageRestore, type BackupBundle } from './backup.ts';
import { CategoryRepository, type Category } from './db/category-repo.ts';
import { TorrentRepository } from './db/torrent-repo.ts';
import { CoreError } from './errors.ts';
import { CoreEvents } from './events.ts';
import { RssRepository } from './rss/rss-repo.ts';
import { UpcomingService } from './media/upcoming.ts';
import { StatsService } from './stats/stats-service.ts';
import { WatchFolder } from './watch/watch-folder.ts';
import { RssService, type RssServiceDeps } from './rss/rss-service.ts';
import { MissingService, type MissingDeps } from './missing/missing-service.ts';
import { SiteService, type SiteFetch } from './sites/site-service.ts';
import { NotificationService } from './notifications/notification-service.ts';
import { wireNotifications } from './notifications/notifier.ts';
import { WebhookNotifier, type WebhookSend } from './notifications/webhook.ts';
import { SearchService } from './search/search-service.ts';
import { fileKeyCipher } from './settings/secret-cipher.ts';
import { SettingsStore, type SecretCipher } from './settings/settings.ts';
import type { TorrentEngine } from './torrent/engine.ts';
import { TorrentManager } from './torrent/manager.ts';
import { WebTorrentEngine } from './torrent/webtorrent-engine.ts';

export interface CoreOptions {
  /** Directory for the database and settings file. */
  configPath: string;
  /** Default download directory, used unless settings/env override it. */
  downloadPath: string;
  env?: NodeJS.ProcessEnv;
  /** Inject an engine (tests). Defaults to WebTorrent configured from settings. */
  engine?: TorrentEngine;
  /** Cipher for secrets at rest. Defaults to an AES key file in `configPath`. */
  cipher?: SecretCipher;
  /** Network overrides for tests. */
  rssFetch?: Pick<RssServiceDeps, 'fetchFeed' | 'fetchTorrent'>;
  /** Network overrides for the missing-episode search (tests). */
  missingFetch?: Pick<MissingDeps, 'fetchText' | 'fetchTorrent'>;
  /** Network override for site searches (tests). */
  siteFetch?: SiteFetch;
  /** Network override for the notification webhook (tests). */
  webhookSend?: WebhookSend;
  /** Don't start background schedulers and don't pace metadata APIs (tests). */
  noSchedulers?: boolean;
}

export interface CategoryService {
  list(): Category[];
  save(c: Category): Category;
  delete(name: string): void;
}

/** All core services. UI-agnostic: used by both the headless server and Electron. */
export interface Core {
  torrents: TorrentManager;
  rss: RssService;
  missing: MissingService;
  sites: SiteService;
  search: SearchService;
  webhook: WebhookNotifier;
  notifications: NotificationService;
  upcoming: UpcomingService;
  stats: StatsService;
  watch: WatchFolder;
  categories: CategoryService;
  /** Whole-instance backup; a staged restore replaces the config on the next start. */
  backup: { create(): BackupBundle; stageRestore(bundle: unknown): void };
  settings: SettingsStore;
  events: CoreEvents;
  engine: TorrentEngine;
  db: Database;
  /**
   * The fatal engine error, if one already happened. It can fire during startup before
   * hosts subscribe to `engine:fatal`, so hosts should check this after subscribing.
   */
  engineFailure(): Error | null;
  /** Flushes state and stops networking. Call once. */
  shutdown(): Promise<void>;
}

/** Composition root: wires services together and restores persisted torrents. */
export function createCore(opts: CoreOptions): Core {
  mkdirSync(opts.configPath, { recursive: true, mode: 0o700 });
  try {
    // Settings, keys and the database are private to the account DraxMax runs as.
    chmodSync(opts.configPath, 0o700);
  } catch {
    // Not ours to change (e.g. a read-only mount point): the files themselves are 0600.
  }
  const restored = applyPendingRestore(opts.configPath);
  const cipher = opts.cipher ?? fileKeyCipher(join(opts.configPath, 'secret.key'));
  const settings = new SettingsStore(
    join(opts.configPath, 'settings.json'),
    { downloadPath: opts.downloadPath },
    opts.env ?? process.env,
    cipher,
  );
  mkdirSync(settings.get().downloadPath, { recursive: true });

  const db: Database = openDatabase(join(opts.configPath, 'draxmax.db'));
  const events = new CoreEvents();
  const notifications = new NotificationService({ db, events, settings: () => settings.get() });
  const unwireNotifications = wireNotifications(events, notifications);
  if (restored)
    notifications.add({
      category: 'system',
      level: 'success',
      title: 'Backup restored',
      body: 'The previous settings and database were kept in the config folder under before-restore.',
      link: '/settings',
    });
  let engineFailure: Error | null = null;
  events.on('engine:fatal', (err) => (engineFailure ??= err));

  const engine =
    opts.engine ??
    new WebTorrentEngine(settings.get(), {
      onFatal: (err) => events.emit('engine:fatal', err),
      onWarning: (err) => events.emit('engine:warning', err),
    });
  const categoryRepo = new CategoryRepository(db);
  const torrents = new TorrentManager({
    repo: new TorrentRepository(db),
    categories: categoryRepo,
    engine,
    events,
    settings: () => settings.get(),
  });
  torrents.init();

  const sites = new SiteService({
    db,
    cipher,
    events,
    ...(opts.siteFetch ? { fetch: opts.siteFetch } : {}),
    ...(opts.noSchedulers ? { intervalMs: 0 } : {}),
  });

  const rssRepo = new RssRepository(db);
  const rss = new RssService({
    repo: rssRepo,
    torrents,
    events,
    settings: () => settings.get(),
    // Feeds and torrent links on a configured site carry its session cookies.
    requestHeaders: (url) => sites.headersFor(url),
    trustsUrl: (url) => sites.ownsUrl(url),
    ...opts.rssFetch,
  });
  if (!opts.noSchedulers) rss.start();

  const missing = new MissingService({
    db,
    repo: rssRepo,
    sites,
    torrents,
    events,
    settings: () => settings.get(),
    ...opts.missingFetch,
    ...(opts.noSchedulers ? { sourceIntervalMs: 0 } : {}),
  });
  if (!opts.noSchedulers) missing.start();

  const search = new SearchService({ missing, sites, torrents, settings });
  const webhook = new WebhookNotifier({
    events,
    settings: () => settings.get(),
    ...(opts.webhookSend ? { send: opts.webhookSend } : {}),
    onError: (message) =>
      notifications.add({
        category: 'system',
        level: 'warning',
        title: 'Notifications could not be sent',
        body: message,
        link: '/settings',
        dedupeKey: 'webhook',
      }),
  });

  // Scheduled speed limits: between the two times of day the alternative limits apply.
  const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  let appliedLimits = '';
  const applyLimits = () => {
    const s = settings.get();
    const now = new Date();
    const t = now.getHours() * 60 + now.getMinutes();
    const from = minutes(s.altSpeedFrom);
    const to = minutes(s.altSpeedTo);
    // A window that ends before it starts runs over midnight.
    const inWindow = from <= to ? t >= from && t < to : t >= from || t < to;
    const alt = s.altSpeedEnabled && from !== to && inWindow;
    const down = alt ? s.altDownloadLimit : s.downloadLimit;
    const up = alt ? s.altUploadLimit : s.uploadLimit;
    if (appliedLimits === `${down}|${up}`) return;
    appliedLimits = `${down}|${up}`;
    engine.setRateLimits(down, up);
  };
  appliedLimits = `${settings.get().downloadLimit}|${settings.get().uploadLimit}`;
  applyLimits();
  const limitTimer = opts.noSchedulers ? null : setInterval(applyLimits, 30_000);
  limitTimer?.unref();

  const upcoming = new UpcomingService({
    db,
    torrents,
    events,
    settings: () => settings.get(),
    ...(opts.noSchedulers ? { anilistIntervalMs: 0 } : {}),
  });
  if (!opts.noSchedulers) upcoming.start();

  const stats = new StatsService({ db, engine, torrents, events, settings: () => settings.get() });
  if (!opts.noSchedulers) stats.start();

  const watch = new WatchFolder({ torrents, events, settings: () => settings.get() });
  if (!opts.noSchedulers) watch.start();

  const categories: CategoryService = {
    list: () => categoryRepo.all(),
    save(c) {
      const name = c.name.trim();
      if (!name || name.length > 100) throw new CoreError('invalid_input', 'Invalid category name');
      const saved = {
        name,
        savePath: c.savePath?.trim() || null,
        seedMinutes: c.seedMinutes ?? null,
        seedRatio: c.seedRatio ?? null,
      };
      categoryRepo.save(saved);
      return saved;
    },
    delete(name) {
      categoryRepo.delete(name);
      torrents.clearCategory(name);
    },
  };

  // Live-applied settings; connection settings need a restart (see RESTART_KEYS).
  settings.onChange((s, changed) => {
    // Key names only, never values (some are secrets). Login changes are recorded by the
    // server as security events; internal bookkeeping keys aren't interesting.
    const shown = changed.filter(
      (k) =>
        ![
          'webuiUsername',
          'webuiPasswordHash',
          'runAsUid',
          'runAsGid',
          'firstRunCompleted',
          // Changed from the Sites page, which reports it there.
          'torznabUrls',
        ].includes(k),
    );
    if (shown.length)
      notifications.add({
        category: 'system',
        level: 'info',
        title: 'Settings changed',
        body: shown.join(', '),
        link: '/settings',
        dedupeKey: `settings:${shown.join(',')}`,
      });
    if (
      changed.some((k) =>
        [
          'downloadLimit',
          'uploadLimit',
          'altSpeedEnabled',
          'altDownloadLimit',
          'altUploadLimit',
          'altSpeedFrom',
          'altSpeedTo',
        ].includes(k),
      )
    )
      applyLimits();
    if (changed.includes('maxActiveDownloads')) torrents.reschedule();
    if (changed.includes('downloadPath')) mkdirSync(s.downloadPath, { recursive: true });
    if (changed.includes('incompletePath') && s.incompletePath)
      mkdirSync(s.incompletePath, { recursive: true });
    // New credentials or sources: refresh the Upcoming lists.
    if (
      ['tmdbApiKey', 'anilistEnabled', 'anilistToken', 'libraryFolders'].some((k) =>
        changed.includes(k as never),
      )
    ) {
      void upcoming.refresh();
    }
    // Newly enabled or new sources: check everything due now.
    if (
      ['missingEnabled', 'missingUseNyaa', 'missingUseAnimeTosho', 'torznabUrls'].some((k) =>
        changed.includes(k as never),
      )
    ) {
      events.emit('missing:updated', null);
      if (s.missingEnabled && !opts.noSchedulers) void missing.run();
    }
  });

  let closed = false;
  return {
    torrents,
    rss,
    missing,
    sites,
    search,
    webhook,
    notifications,
    upcoming,
    stats,
    watch,
    categories,
    backup: {
      create: () => createBackup(db, opts.configPath),
      stageRestore: (bundle) => stageRestore(opts.configPath, bundle),
    },
    settings,
    events,
    engine,
    db,
    engineFailure: () => engineFailure,
    async shutdown() {
      if (closed) return;
      closed = true;
      rss.stop();
      missing.stop();
      webhook.stop();
      if (limitTimer) clearInterval(limitTimer);
      unwireNotifications();
      upcoming.stop();
      stats.stop();
      watch.stop();
      await torrents.shutdown();
      db.close();
    },
  };
}
