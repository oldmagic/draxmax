import { EventEmitter } from 'node:events';
import type { NotificationDTO, StatsSnapshot, TorrentItem, UpcomingItemDTO } from '@draxmax/shared';

export interface CoreEventMap {
  /** Second argument: who added it ("rss" with the rule name, "watch", "manual", …). */
  'torrent:added': [TorrentItem, { origin: string; detail: string | null }];
  'torrent:removed': [string];
  'torrent:done': [TorrentItem];
  /** Reached a seeding limit: stopped, or removed from the list. */
  'torrent:seeded': [TorrentItem, { removed: boolean }];
  'torrent:error': [TorrentItem];
  /** The BitTorrent engine died (e.g. port in use). The host should report and restart. */
  'engine:fatal': [Error];
  /** A feed was refreshed or its articles changed (feed id, or null for many). */
  'rss:updated': [string | null];
  /** A download rule matched an article and added (or found) the torrent. */
  'rss:match': [{ ruleName: string; title: string; status: 'added' | 'duplicate' }];
  /** One-second statistics sample. */
  'stats:tick': [StatsSnapshot];
  /** Upcoming lists changed or a refresh started/finished. */
  'upcoming:updated': [null];
  /** Missing-episode check state changed (run started, show checked, finished). */
  'missing:updated': [null];
  /** Sites were added, changed, tested or removed. */
  'sites:updated': [null];
  /** A feed started failing (ok: false) or works again (ok: true). */
  'rss:feed-status': [{ feedId: string; title: string; ok: boolean; error: string | null }];
  /** A missing-episode run finished: torrents added and sources that failed. */
  'missing:run': [{ added: number; failing: { source: string; error: string }[] }];
  /** Upcoming found For You items it hadn't shown before. */
  'upcoming:new': [UpcomingItemDTO[]];
  /** The notification history changed (new entry, read state, cleared). */
  'notifications:updated': [{ unread: number; item: NotificationDTO | null }];
  /** Recoverable engine problem (e.g. uTP port unavailable, continuing TCP-only). */
  'engine:warning': [Error];
}

/** Strongly typed event bus shared by all core services. */
export class CoreEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  on<E extends keyof CoreEventMap>(event: E, fn: (...args: CoreEventMap[E]) => void): () => void {
    this.emitter.on(event, fn as (...args: unknown[]) => void);
    return () => this.emitter.off(event, fn as (...args: unknown[]) => void);
  }

  emit<E extends keyof CoreEventMap>(event: E, ...args: CoreEventMap[E]): void {
    this.emitter.emit(event, ...args);
  }
}
