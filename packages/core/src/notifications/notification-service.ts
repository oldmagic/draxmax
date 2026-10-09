import type {
  NotificationCategory,
  NotificationDTO,
  NotificationLevel,
  NotificationList,
} from '@draxmax/shared';
import type { Database } from '../db/database.ts';
import type { CoreEvents } from '../events.ts';
import type { Settings } from '../settings/settings.ts';

export interface NewNotification {
  category: NotificationCategory;
  level: NotificationLevel;
  title: string;
  body?: string | null | undefined;
  /** In-app route, e.g. "/rss". */
  link?: string | null | undefined;
  /** Repeats with the same key within {@link DEDUPE_WINDOW_MS} are combined into one entry. */
  dedupeKey?: string | undefined;
}

export interface NotificationDeps {
  db: Database;
  events: CoreEvents;
  settings: () => Settings;
  now?: () => number;
}

/** Repeats inside this window bump one entry instead of adding rows. */
export const DEDUPE_WINDOW_MS = 10 * 60_000;
const MAX_ITEMS = 2000;
const MAX_TITLE = 200;
const MAX_BODY = 1000;

const HISTORY_KEY: Record<NotificationCategory, keyof Settings> = {
  download: 'historyDownload',
  rss: 'historyRss',
  upcoming: 'historyUpcoming',
  security: 'historySecurity',
  system: 'historySystem',
};

/** Hides credentials that may appear in URLs or messages (passkeys, API keys, tokens). */
export function redactText(s: string): string {
  return s.replace(
    /([?&;\s](?:passkey|apikey|api_key|token|torrent_pass|authkey|rsskey|key|pass)=)[^&\s"'#]+/gi,
    '$1•••',
  );
}

type Raw = Record<string, unknown>;

function toDTO(r: Raw): NotificationDTO {
  return {
    id: r.id as number,
    category: r.category as NotificationCategory,
    level: r.level as NotificationLevel,
    title: r.title as string,
    body: (r.body as string | null) ?? null,
    link: (r.link as string | null) ?? null,
    count: r.count as number,
    read: r.read === 1,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

/**
 * Persistent history of what happened (downloads, RSS, missing episodes, Upcoming, logins,
 * settings), with read/unread state shared by every client.
 */
export class NotificationService {
  constructor(private readonly deps: NotificationDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Records an event (unless its category is turned off). Returns the stored entry. */
  add(n: NewNotification): NotificationDTO | null {
    const settings = this.deps.settings();
    if (settings[HISTORY_KEY[n.category]] === false) return null;
    const db = this.deps.db;
    const at = new Date(this.now()).toISOString();
    const title = redactText(n.title).slice(0, MAX_TITLE);
    const body = n.body ? redactText(n.body).slice(0, MAX_BODY) : null;

    let id: number | null = null;
    if (n.dedupeKey) {
      const prev = db
        .prepare(
          'SELECT id FROM notifications WHERE dedupe_key = ? AND read = 0 AND updated_at >= ? ORDER BY id DESC LIMIT 1',
        )
        .get(n.dedupeKey, new Date(this.now() - DEDUPE_WINDOW_MS).toISOString()) as
        { id: number } | undefined;
      if (prev) {
        db.prepare(
          'UPDATE notifications SET count = count + 1, updated_at = ?, title = ?, body = ?, level = ? WHERE id = ?',
        ).run(at, title, body, n.level, prev.id);
        id = prev.id;
      }
    }
    if (id === null) {
      const res = db
        .prepare(
          `INSERT INTO notifications (category, level, title, body, link, dedupe_key, count, read, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
        )
        .run(n.category, n.level, title, body, n.link ?? null, n.dedupeKey ?? null, at, at);
      id = Number(res.lastInsertRowid);
      this.prune();
    }
    const item = toDTO(db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as Raw);
    this.deps.events.emit('notifications:updated', { unread: this.unreadCount(), item });
    return item;
  }

  /** Drops entries older than the retention period, and beyond the newest {@link MAX_ITEMS}. */
  private prune(): void {
    const days = this.deps.settings().notificationRetentionDays;
    const cutoff = new Date(this.now() - days * 86_400_000).toISOString();
    this.deps.db.prepare('DELETE FROM notifications WHERE updated_at < ?').run(cutoff);
    this.deps.db
      .prepare(
        'DELETE FROM notifications WHERE id <= (SELECT id FROM notifications ORDER BY id DESC LIMIT 1 OFFSET ?)',
      )
      .run(MAX_ITEMS);
  }

  list(
    opts: {
      unread?: boolean | undefined;
      category?: NotificationCategory | undefined;
      q?: string | undefined;
      before?: number | undefined;
      limit?: number | undefined;
    } = {},
  ): NotificationList {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.unread) where.push('read = 0');
    if (opts.category) {
      where.push('category = ?');
      args.push(opts.category);
    }
    if (opts.q) {
      where.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
      const like = `%${opts.q.replace(/[\\%_]/g, '\\$&')}%`;
      args.push(like, like);
    }
    if (opts.before) {
      where.push('id < ?');
      args.push(opts.before);
    }
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const rows = this.deps.db
      .prepare(
        `SELECT * FROM notifications ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
      )
      .all(...args, limit + 1) as Raw[];
    return {
      items: rows.slice(0, limit).map(toDTO),
      unread: this.unreadCount(),
      hasMore: rows.length > limit,
    };
  }

  unreadCount(): number {
    return (
      this.deps.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read = 0').get() as {
        n: number;
      }
    ).n;
  }

  /** Marks entries (or all) read or unread. Returns how many changed. */
  markRead(ids: number[] | 'all', read: boolean): number {
    const flag = read ? 1 : 0;
    const res =
      ids === 'all'
        ? this.deps.db.prepare('UPDATE notifications SET read = ? WHERE read != ?').run(flag, flag)
        : this.deps.db
            .prepare(
              `UPDATE notifications SET read = ? WHERE read != ? AND id IN (${ids.map(() => '?').join(',')})`,
            )
            .run(flag, flag, ...ids);
    this.deps.events.emit('notifications:updated', { unread: this.unreadCount(), item: null });
    return Number(res.changes);
  }

  /** Deletes read entries, or everything. */
  clear(opts: { readOnly: boolean }): number {
    const res = this.deps.db
      .prepare(
        opts.readOnly ? 'DELETE FROM notifications WHERE read = 1' : 'DELETE FROM notifications',
      )
      .run();
    this.deps.events.emit('notifications:updated', { unread: this.unreadCount(), item: null });
    return Number(res.changes);
  }
}
