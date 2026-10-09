import type { ArticleDTO, DownloadRule, FeedDTO, RssHistoryDTO } from '@draxmax/shared';
import type { Database } from '../db/database.ts';
import type { ParsedFeedItem } from './feed-parser.ts';

export interface FeedRow {
  id: string;
  url: string;
  title: string;
  enabled: boolean;
  refreshMinutes: number | null;
  lastFetched: string | null;
  lastError: string | null;
  nextFetchAt: string | null;
  failures: number;
  createdAt: string;
}

export interface RuleRow extends DownloadRule {
  lastMatchAt: string | null;
  createdAt: string;
}

const j = (v: unknown) => JSON.stringify(v);
const p = <T>(v: string): T => JSON.parse(v) as T;
const b = (v: boolean) => (v ? 1 : 0);

type Raw = Record<string, unknown>;

function feedFromRow(r: Raw): FeedRow {
  return {
    id: r.id as string,
    url: r.url as string,
    title: r.title as string,
    enabled: r.enabled === 1,
    refreshMinutes: (r.refresh_minutes as number | null) ?? null,
    lastFetched: (r.last_fetched as string | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    nextFetchAt: (r.next_fetch_at as string | null) ?? null,
    failures: r.failures as number,
    createdAt: r.created_at as string,
  };
}

function ruleFromRow(r: Raw): RuleRow {
  const rule: RuleRow = {
    id: r.id as string,
    name: r.name as string,
    enabled: r.enabled === 1,
    priority: r.priority as number,
    mustContain: p(r.must_contain as string),
    mustNotContain: p(r.must_not_contain as string),
    useRegex: r.use_regex === 1,
    smartEpisodeFilter: r.smart_episode_filter === 1,
    assignedFeedIds: p(r.assigned_feed_ids as string),
    tags: p(r.tags as string),
    addPaused: r.add_paused === 1,
    lastMatchAt: (r.last_match_at as string | null) ?? null,
    createdAt: r.created_at as string,
  };
  if (r.episode_filter) rule.episodeFilter = r.episode_filter as string;
  if (r.ignore_subsequent_days != null)
    rule.ignoreSubsequentDays = r.ignore_subsequent_days as number;
  if (r.category) rule.category = r.category as string;
  if (r.save_path) rule.savePath = r.save_path as string;
  return rule;
}

function articleFromRow(r: Raw): ArticleDTO {
  return {
    feedId: r.feed_id as string,
    id: r.id as string,
    title: r.title as string,
    link: r.link as string,
    torrentURL: (r.torrent_url as string | null) ?? null,
    pubDate: r.pub_date as string,
    size: (r.size as number | null) ?? null,
    isRead: r.is_read === 1,
    matchedRuleIds: p(r.matched_rule_ids as string),
    downloaded: r.downloaded === 1,
  };
}

/** Persistence for feeds, articles, rules and download history. */
export class RssRepository {
  constructor(private readonly db: Database) {}

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // --- Feeds -------------------------------------------------------------------

  feeds(): FeedRow[] {
    return (
      this.db.prepare('SELECT * FROM rss_feeds ORDER BY title COLLATE NOCASE').all() as Raw[]
    ).map(feedFromRow);
  }

  feed(id: string): FeedRow | null {
    const r = this.db.prepare('SELECT * FROM rss_feeds WHERE id = ?').get(id) as Raw | undefined;
    return r ? feedFromRow(r) : null;
  }

  feedByUrl(url: string): FeedRow | null {
    const r = this.db.prepare('SELECT * FROM rss_feeds WHERE url = ?').get(url) as Raw | undefined;
    return r ? feedFromRow(r) : null;
  }

  /** Runs `fn` in one transaction (rolled back if it throws). */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  saveFeed(f: FeedRow): void {
    this.db
      .prepare(
        `INSERT INTO rss_feeds (id, url, title, enabled, refresh_minutes, last_fetched, last_error, next_fetch_at, failures, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET url = excluded.url, title = excluded.title, enabled = excluded.enabled,
           refresh_minutes = excluded.refresh_minutes, last_fetched = excluded.last_fetched, last_error = excluded.last_error,
           next_fetch_at = excluded.next_fetch_at, failures = excluded.failures`,
      )
      .run(
        f.id,
        f.url,
        f.title,
        b(f.enabled),
        f.refreshMinutes,
        f.lastFetched,
        f.lastError,
        f.nextFetchAt,
        f.failures,
        f.createdAt,
      );
  }

  deleteFeed(id: string): void {
    this.db.prepare('DELETE FROM rss_feeds WHERE id = ?').run(id);
  }

  /** Unread and total article counts per feed. */
  counts(): Map<string, { unread: number; total: number }> {
    const rows = this.db
      .prepare(
        'SELECT feed_id, SUM(is_read = 0) AS unread, COUNT(*) AS total FROM rss_articles GROUP BY feed_id',
      )
      .all() as { feed_id: string; unread: number; total: number }[];
    return new Map(rows.map((r) => [r.feed_id, { unread: r.unread, total: r.total }]));
  }

  toFeedDTO(
    f: FeedRow,
    defaultMinutes: number,
    counts: Map<string, { unread: number; total: number }>,
  ): FeedDTO {
    const c = counts.get(f.id) ?? { unread: 0, total: 0 };
    return {
      id: f.id,
      url: f.url,
      title: f.title,
      enabled: f.enabled,
      refreshIntervalMinutes: f.refreshMinutes ?? defaultMinutes,
      customRefreshMinutes: f.refreshMinutes,
      lastFetched: f.lastFetched,
      lastError: f.lastError,
      nextFetchAt: f.nextFetchAt,
      unread: c.unread,
      total: c.total,
    };
  }

  // --- Articles ------------------------------------------------------------------

  /** Inserts unseen items; returns the ones that were new. Trims to `keep` newest per feed. */
  upsertArticles(feedId: string, items: ParsedFeedItem[], keep: number): ParsedFeedItem[] {
    return this.tx(() => {
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO rss_articles (feed_id, id, title, link, torrent_url, pub_date, size, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = new Date().toISOString();
      const fresh: ParsedFeedItem[] = [];
      for (const it of items) {
        const res = insert.run(
          feedId,
          it.id,
          it.title,
          it.link,
          it.torrentURL,
          it.pubDate.toISOString(),
          it.size,
          now,
        );
        if (res.changes > 0) fresh.push(it);
      }
      this.db
        .prepare(
          `DELETE FROM rss_articles WHERE feed_id = ? AND id NOT IN (
             SELECT id FROM rss_articles WHERE feed_id = ? ORDER BY pub_date DESC LIMIT ?)`,
        )
        .run(feedId, feedId, keep);
      return fresh;
    });
  }

  articles(opts: {
    feedId?: string | undefined;
    unreadOnly?: boolean;
    query?: string | undefined;
    limit?: number;
    offset?: number;
  }): ArticleDTO[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.feedId) {
      where.push('a.feed_id = ?');
      params.push(opts.feedId);
    }
    if (opts.unreadOnly) where.push('a.is_read = 0');
    if (opts.query) {
      where.push("a.title LIKE ? ESCAPE '\\'");
      params.push(`%${opts.query.replace(/[%_]/g, (m) => `\\${m}`)}%`);
    }
    const sql = `SELECT a.*, EXISTS (SELECT 1 FROM rss_downloads d WHERE d.feed_id = a.feed_id AND d.article_id = a.id AND d.status != 'failed') AS downloaded
      FROM rss_articles a ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.pub_date DESC LIMIT ? OFFSET ?`;
    params.push(opts.limit ?? 200, opts.offset ?? 0);
    return (this.db.prepare(sql).all(...params) as Raw[]).map(articleFromRow);
  }

  article(feedId: string, id: string): ArticleDTO | null {
    const r = this.db
      .prepare(
        `SELECT a.*, EXISTS (SELECT 1 FROM rss_downloads d WHERE d.feed_id = a.feed_id AND d.article_id = a.id AND d.status != 'failed') AS downloaded
         FROM rss_articles a WHERE a.feed_id = ? AND a.id = ?`,
      )
      .get(feedId, id) as Raw | undefined;
    return r ? articleFromRow(r) : null;
  }

  setRead(
    read: boolean,
    opts: { feedId?: string | undefined; articles?: { feedId: string; id: string }[] | undefined },
  ): void {
    this.tx(() => {
      if (opts.articles) {
        const st = this.db.prepare(
          'UPDATE rss_articles SET is_read = ? WHERE feed_id = ? AND id = ?',
        );
        for (const a of opts.articles) st.run(b(read), a.feedId, a.id);
      } else if (opts.feedId) {
        this.db
          .prepare('UPDATE rss_articles SET is_read = ? WHERE feed_id = ?')
          .run(b(read), opts.feedId);
      } else {
        this.db.prepare('UPDATE rss_articles SET is_read = ?').run(b(read));
      }
    });
  }

  addMatchedRule(feedId: string, id: string, ruleId: string): void {
    const a = this.article(feedId, id);
    if (!a || a.matchedRuleIds.includes(ruleId)) return;
    this.db
      .prepare('UPDATE rss_articles SET matched_rule_ids = ? WHERE feed_id = ? AND id = ?')
      .run(j([...a.matchedRuleIds, ruleId]), feedId, id);
  }

  // --- Rules ---------------------------------------------------------------------

  rules(): RuleRow[] {
    return (
      this.db
        .prepare('SELECT * FROM rss_rules ORDER BY priority, name COLLATE NOCASE')
        .all() as Raw[]
    ).map(ruleFromRow);
  }

  rule(id: string): RuleRow | null {
    const r = this.db.prepare('SELECT * FROM rss_rules WHERE id = ?').get(id) as Raw | undefined;
    return r ? ruleFromRow(r) : null;
  }

  saveRule(r: RuleRow): void {
    this.db
      .prepare(
        `INSERT INTO rss_rules (id, name, enabled, priority, must_contain, must_not_contain, use_regex, episode_filter,
           smart_episode_filter, ignore_subsequent_days, assigned_feed_ids, category, tags, save_path, add_paused, last_match_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, enabled = excluded.enabled, priority = excluded.priority,
           must_contain = excluded.must_contain, must_not_contain = excluded.must_not_contain, use_regex = excluded.use_regex,
           episode_filter = excluded.episode_filter, smart_episode_filter = excluded.smart_episode_filter,
           ignore_subsequent_days = excluded.ignore_subsequent_days, assigned_feed_ids = excluded.assigned_feed_ids,
           category = excluded.category, tags = excluded.tags, save_path = excluded.save_path, add_paused = excluded.add_paused,
           last_match_at = excluded.last_match_at`,
      )
      .run(
        r.id,
        r.name,
        b(r.enabled),
        r.priority,
        j(r.mustContain),
        j(r.mustNotContain),
        b(r.useRegex),
        r.episodeFilter ?? null,
        b(r.smartEpisodeFilter),
        r.ignoreSubsequentDays ?? null,
        j(r.assignedFeedIds),
        r.category ?? null,
        j(r.tags),
        r.savePath ?? null,
        b(r.addPaused),
        r.lastMatchAt,
        r.createdAt,
      );
  }

  deleteRule(id: string): void {
    this.db.prepare('DELETE FROM rss_rules WHERE id = ?').run(id);
  }

  // --- History -------------------------------------------------------------------

  recordDownload(d: {
    ruleId: string | null;
    ruleName: string | null;
    feedId: string;
    articleId: string;
    articleTitle: string;
    torrentUrl: string | null;
    episodeKeys: string[];
    repack: boolean;
    torrentId: string | null;
    status: 'added' | 'duplicate' | 'failed';
    error: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO rss_downloads (rule_id, rule_name, feed_id, article_id, article_title, torrent_url, episode_keys, repack, torrent_id, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.ruleId,
        d.ruleName,
        d.feedId,
        d.articleId,
        d.articleTitle,
        d.torrentUrl,
        j(d.episodeKeys),
        b(d.repack),
        d.torrentId,
        d.status,
        d.error,
        new Date().toISOString(),
      );
  }

  /** Episode keys a rule has successfully downloaded. */
  downloadedEpisodes(ruleId: string): Map<string, { repack: boolean }> {
    const rows = this.db
      .prepare(
        "SELECT episode_keys, repack FROM rss_downloads WHERE rule_id = ? AND status != 'failed' ORDER BY id",
      )
      .all(ruleId) as { episode_keys: string; repack: number }[];
    const out = new Map<string, { repack: boolean }>();
    for (const r of rows)
      for (const k of p<string[]>(r.episode_keys))
        out.set(k, { repack: r.repack === 1 || (out.get(k)?.repack ?? false) });
    return out;
  }

  wasDownloaded(feedId: string, articleId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM rss_downloads WHERE feed_id = ? AND article_id = ? AND status != 'failed'",
      )
      .get(feedId, articleId);
  }

  history(limit = 200): RssHistoryDTO[] {
    const rows = this.db
      .prepare('SELECT * FROM rss_downloads ORDER BY id DESC LIMIT ?')
      .all(limit) as Raw[];
    return rows.map((r) => ({
      id: r.id as number,
      ruleId: (r.rule_id as string | null) ?? null,
      ruleName: (r.rule_name as string | null) ?? null,
      feedId: r.feed_id as string,
      articleTitle: r.article_title as string,
      torrentId: (r.torrent_id as string | null) ?? null,
      status: r.status as RssHistoryDTO['status'],
      error: (r.error as string | null) ?? null,
      createdAt: r.created_at as string,
    }));
  }

  clearHistory(): void {
    this.db.prepare('DELETE FROM rss_downloads').run();
  }
}
