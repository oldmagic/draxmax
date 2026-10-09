import { randomUUID } from 'node:crypto';
import type {
  ArticleDTO,
  FeedDTO,
  RssHistoryDTO,
  RuleDTO,
  RssConfig,
  RssConfigInput,
  RssConfigSaveResult,
  RuleFeedsRequest,
  RuleFeedsResult,
  RuleImportResult,
  RuleInput,
} from '@draxmax/shared';
import { MAGNET_RE } from '@draxmax/shared';
import { CoreError } from '../errors.ts';
import type { CoreEvents } from '../events.ts';
import { fetchBytes } from '../net/http.ts';
import type { Settings } from '../settings/settings.ts';
import type { AddOptions, TorrentManager } from '../torrent/manager.ts';
import { parseFeed, type ParsedFeedItem } from './feed-parser.ts';
import { parseQbRules } from './qbittorrent.ts';
import { evaluateRule, orderRules, RuleSyntaxError, validateRule } from './rules.ts';
import type { FeedRow, RssRepository, RuleRow } from './rss-repo.ts';

const SCHEDULER_TICK_MS = 30_000;
const MAX_BACKOFF_MS = 24 * 3600 * 1000;
const FETCH_CONCURRENCY = 2;

export interface RssServiceDeps {
  repo: RssRepository;
  torrents: TorrentManager;
  events: CoreEvents;
  settings: () => Settings;
  /** Injected for tests. */
  fetchFeed?: (url: string, headers: Record<string, string>) => Promise<string>;
  fetchTorrent?: (
    url: string,
    opts: { allowPrivate: boolean; headers: Record<string, string> },
  ) => Promise<Uint8Array>;
  /** Extra request headers (site cookies) for a URL. */
  requestHeaders?: (url: string) => Record<string, string>;
  /** URLs on user-configured sites may reach the local network. */
  trustsUrl?: (url: string) => boolean;
}

/** Feeds, articles, download rules and the background refresh scheduler. */
export class RssService {
  private timer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Map<string, Promise<FeedDTO>>();
  private closed = false;

  constructor(private readonly deps: RssServiceDeps) {}

  private get repo(): RssRepository {
    return this.deps.repo;
  }

  /** Starts the scheduler; due feeds are refreshed shortly after startup. */
  start(): void {
    this.timer = setInterval(() => void this.refreshDue(), SCHEDULER_TICK_MS);
    this.timer.unref();
    setTimeout(() => void this.refreshDue(), 5_000).unref();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
  }

  // --- Feeds -------------------------------------------------------------------

  feeds(): FeedDTO[] {
    const counts = this.repo.counts();
    const def = this.deps.settings().rssRefreshMinutes;
    return this.repo.feeds().map((f) => this.repo.toFeedDTO(f, def, counts));
  }

  private feedDTO(id: string): FeedDTO {
    const f = this.repo.feed(id);
    if (!f) throw new CoreError('not_found', 'Feed not found');
    return this.repo.toFeedDTO(f, this.deps.settings().rssRefreshMinutes, this.repo.counts());
  }

  /** Adds a feed and fetches it immediately (a fetch failure keeps the feed, with the error shown). */
  async addFeed(url: string, refreshMinutes: number | null = null): Promise<FeedDTO> {
    const clean = url.trim();
    if (this.repo.feedByUrl(clean)) throw new CoreError('conflict', 'This feed is already added');
    const feed: FeedRow = {
      id: randomUUID(),
      url: clean,
      title: new URL(clean).host,
      enabled: true,
      refreshMinutes,
      lastFetched: null,
      lastError: null,
      nextFetchAt: new Date().toISOString(),
      failures: 0,
      createdAt: new Date().toISOString(),
    };
    this.repo.saveFeed(feed);
    return this.refreshFeed(feed.id);
  }

  updateFeed(
    id: string,
    patch: {
      url?: string | undefined;
      title?: string | undefined;
      enabled?: boolean | undefined;
      refreshMinutes?: number | null | undefined;
    },
  ): FeedDTO {
    const f = this.repo.feed(id);
    if (!f) throw new CoreError('not_found', 'Feed not found');
    if (patch.url !== undefined && patch.url !== f.url) {
      if (this.repo.feedByUrl(patch.url))
        throw new CoreError('conflict', 'Another feed already uses this URL');
      f.url = patch.url;
      f.nextFetchAt = new Date().toISOString();
      f.failures = 0;
    }
    if (patch.title !== undefined) f.title = patch.title;
    if (patch.enabled !== undefined) f.enabled = patch.enabled;
    if (patch.refreshMinutes !== undefined) f.refreshMinutes = patch.refreshMinutes;
    this.repo.saveFeed(f);
    return this.feedDTO(id);
  }

  deleteFeed(id: string): void {
    this.repo.deleteFeed(id);
    for (const r of this.repo.rules()) {
      if (r.assignedFeedIds.includes(id)) {
        this.repo.saveRule({ ...r, assignedFeedIds: r.assignedFeedIds.filter((x) => x !== id) });
      }
    }
    this.deps.events.emit('rss:updated', null);
  }

  /** Fetches one feed now. Concurrent calls for the same feed share one request. */
  refreshFeed(id: string): Promise<FeedDTO> {
    const existing = this.inFlight.get(id);
    if (existing) return existing;
    const job = this.doRefresh(id).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, job);
    return job;
  }

  /** Refreshes every enabled feed now. */
  async refreshAll(): Promise<void> {
    const ids = this.repo
      .feeds()
      .filter((f) => f.enabled)
      .map((f) => f.id);
    await this.runLimited(ids);
  }

  private async refreshDue(): Promise<void> {
    if (this.closed || !this.deps.settings().rssEnabled) return;
    const now = Date.now();
    const due = this.repo
      .feeds()
      .filter((f) => f.enabled && (!f.nextFetchAt || Date.parse(f.nextFetchAt) <= now))
      .map((f) => f.id);
    await this.runLimited(due);
  }

  private async runLimited(ids: string[]): Promise<void> {
    const queue = [...ids];
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        try {
          await this.refreshFeed(id);
        } catch {
          // Recorded on the feed row.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, ids.length) }, worker));
  }

  private async doRefresh(id: string): Promise<FeedDTO> {
    const feed = this.repo.feed(id);
    if (!feed) throw new CoreError('not_found', 'Feed not found');
    const settings = this.deps.settings();
    const intervalMs = (feed.refreshMinutes ?? settings.rssRefreshMinutes) * 60_000;
    try {
      const xml = await (this.deps.fetchFeed ?? defaultFetchFeed)(
        feed.url,
        this.deps.requestHeaders?.(feed.url) ?? {},
      );
      const parsed = await parseFeed(xml).catch(() => {
        throw new Error('Not a valid RSS or Atom feed');
      });
      const fresh = this.repo.upsertArticles(id, parsed.items, settings.rssMaxArticlesPerFeed);
      // Keep a user-edited title; replace the host placeholder with the feed's own title.
      if (parsed.title && (feed.title === new URL(feed.url).host || !feed.lastFetched))
        feed.title = parsed.title.slice(0, 200);
      feed.lastFetched = new Date().toISOString();
      if (feed.failures > 0)
        this.deps.events.emit('rss:feed-status', {
          feedId: id,
          title: feed.title,
          ok: true,
          error: null,
        });
      feed.lastError = null;
      feed.failures = 0;
      feed.nextFetchAt = new Date(Date.now() + intervalMs).toISOString();
      this.repo.saveFeed(feed);
      if (fresh.length) await this.processArticles(id, fresh);
    } catch (err) {
      feed.failures += 1;
      feed.lastError = (err as Error).message;
      // Report the change from working to failing once, not every retry.
      if (feed.failures === 1)
        this.deps.events.emit('rss:feed-status', {
          feedId: id,
          title: feed.title,
          ok: false,
          error: feed.lastError,
        });
      const backoff = Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** Math.min(feed.failures - 1, 6));
      feed.nextFetchAt = new Date(Date.now() + backoff).toISOString();
      this.repo.saveFeed(feed);
    }
    this.deps.events.emit('rss:updated', id);
    return this.feedDTO(id);
  }

  // --- Articles ------------------------------------------------------------------

  articles(opts: {
    feedId?: string | undefined;
    unreadOnly?: boolean;
    query?: string | undefined;
    limit?: number;
    offset?: number;
  }): ArticleDTO[] {
    return this.repo.articles(opts);
  }

  markRead(
    read: boolean,
    opts: { feedId?: string | undefined; articles?: { feedId: string; id: string }[] | undefined },
  ): void {
    this.repo.setRead(read, opts);
    this.deps.events.emit('rss:updated', opts.feedId ?? null);
  }

  /** Manually downloads one article (no rule). */
  async downloadArticle(
    feedId: string,
    id: string,
  ): Promise<{ torrentId: string | null; status: 'added' | 'duplicate' }> {
    const article = this.repo.article(feedId, id);
    if (!article) throw new CoreError('not_found', 'Article not found');
    if (!article.torrentURL)
      throw new CoreError('invalid_input', 'This article has no torrent or magnet link');
    const res = await this.addTorrent(
      article.torrentURL,
      { origin: 'manual', originDetail: 'RSS article' },
      feedId,
    );
    this.repo.recordDownload({
      ruleId: null,
      ruleName: null,
      feedId,
      articleId: id,
      articleTitle: article.title,
      torrentUrl: article.torrentURL,
      episodeKeys: [],
      repack: false,
      torrentId: res.torrentId,
      status: res.status,
      error: null,
    });
    this.repo.setRead(true, { articles: [{ feedId, id }] });
    this.deps.events.emit('rss:updated', feedId);
    return res;
  }

  // --- Rules ---------------------------------------------------------------------

  rules(): RuleDTO[] {
    return this.repo.rules().map(toRuleDTO);
  }

  async saveRule(input: RuleInput, id?: string): Promise<RuleDTO> {
    try {
      validateRule({ ...input, episodeFilter: input.episodeFilter });
    } catch (err) {
      if (err instanceof RuleSyntaxError) throw new CoreError('invalid_input', err.message);
      throw err;
    }
    const existing = id ? this.repo.rule(id) : null;
    if (id && !existing) throw new CoreError('not_found', 'Rule not found');
    const rule = toRuleRow(input, existing);
    this.repo.saveRule(rule);
    // Like qBittorrent: a saved rule is applied to articles already in the feeds.
    if (rule.enabled) await this.applyRuleToExisting(rule);
    return toRuleDTO(this.repo.rule(rule.id)!);
  }

  /**
   * Imports a qBittorrent rules export. Rules are matched to feeds by URL; a rule with the
   * same name is replaced. Missing feeds are added first, so their initial fetch can't
   * download a feed's whole backlog through the imported rules.
   */
  async importQbRules(
    json: Record<string, unknown>,
    opts: { createMissingFeeds: boolean; applyToExisting: boolean },
  ): Promise<RuleImportResult> {
    const { rules, errors } = parseQbRules(json, this.deps.settings().downloadPath);
    const warnings: RuleImportResult['warnings'] = [];
    const feedIds = new Map(this.repo.feeds().map((f) => [f.url, f.id]));
    let feedsCreated = 0;

    if (opts.createMissingFeeds) {
      for (const url of new Set(rules.flatMap((r) => r.feedUrls))) {
        if (feedIds.has(url)) continue;
        if (!/^https?:\/\//i.test(url)) {
          errors.push({ name: url, error: 'Only http(s) feeds can be added' });
          continue;
        }
        try {
          feedIds.set(url, (await this.addFeed(url)).id);
          feedsCreated++;
        } catch (err) {
          errors.push({ name: url, error: (err as Error).message });
        }
      }
    }

    const byName = new Map(this.repo.rules().map((r) => [r.name, r]));
    let created = 0;
    let updated = 0;
    for (const r of rules) {
      const assignedFeedIds = r.feedUrls.flatMap((u) => feedIds.get(u) ?? []);
      let enabled = r.input.enabled;
      // In qBittorrent a rule without feeds does nothing; here it would apply to every feed.
      if (assignedFeedIds.length === 0 && enabled) {
        enabled = false;
        warnings.push({
          name: r.input.name,
          warning: r.feedUrls.length
            ? 'None of its feeds are subscribed; imported disabled.'
            : 'It has no feeds; imported disabled.',
        });
      }
      const existing = byName.get(r.input.name) ?? null;
      const rule = toRuleRow({ ...r.input, enabled, assignedFeedIds }, existing);
      rule.lastMatchAt = r.lastMatchAt ?? existing?.lastMatchAt ?? null;
      this.repo.saveRule(rule);
      if (existing) updated++;
      else created++;
      if (opts.applyToExisting && rule.enabled) await this.applyRuleToExisting(rule);
    }
    this.deps.events.emit('rss:updated', null);
    return { created, updated, feedsCreated, errors, warnings };
  }

  deleteRule(id: string): void {
    this.repo.deleteRule(id);
  }

  /** Deletes several rules; unknown ids are ignored. Returns how many existed. */
  deleteRules(ids: string[]): number {
    const known = new Set(this.repo.rules().map((r) => r.id));
    const doomed = [...new Set(ids)].filter((id) => known.has(id));
    for (const id of doomed) this.repo.deleteRule(id);
    return doomed.length;
  }

  /**
   * Adds and removes feeds on several rules in one go. A rule left with no feeds applies to
   * every feed, as in the editor. With `enable`, disabled rules that end up with a feed are
   * turned on (rules imported without a subscribed feed come in disabled).
   */
  async setRuleFeeds(req: RuleFeedsRequest): Promise<RuleFeedsResult> {
    const known = new Set(this.repo.feeds().map((f) => f.id));
    const unknown = req.add.find((id) => !known.has(id));
    if (unknown) throw new CoreError('invalid_input', 'Feed not found');
    const remove = new Set(req.remove);
    const ids = new Set(req.ids);
    const changed: RuleRow[] = [];
    let enabled = 0;
    for (const rule of this.repo.rules()) {
      if (!ids.has(rule.id)) continue;
      const feeds = [
        ...new Set([...rule.assignedFeedIds, ...req.add].filter((id) => !remove.has(id))),
      ];
      const turnOn = req.enable && !rule.enabled && feeds.length > 0;
      const sameFeeds =
        feeds.length === rule.assignedFeedIds.length &&
        feeds.every((id) => rule.assignedFeedIds.includes(id));
      if (sameFeeds && !turnOn) continue;
      const next = { ...rule, assignedFeedIds: feeds, enabled: rule.enabled || turnOn };
      this.repo.saveRule(next);
      changed.push(next);
      if (turnOn) enabled++;
    }
    if (req.applyToExisting)
      for (const rule of changed) if (rule.enabled) await this.applyRuleToExisting(rule);
    this.deps.events.emit('rss:updated', null);
    return { updated: changed.length, enabled };
  }

  // --- Feeds and rules as JSON -----------------------------------------------------

  /** Feeds and rules as one editable document (rules reference feeds by URL). */
  exportConfig(): RssConfig {
    const feeds = this.repo.feeds();
    const urlById = new Map(feeds.map((f) => [f.id, f.url]));
    return {
      feeds: feeds.map((f) => ({
        url: f.url,
        title: f.title,
        enabled: f.enabled,
        refreshMinutes: f.refreshMinutes,
      })),
      rules: orderRules(this.repo.rules()).map((r) => ({
        id: r.id,
        name: r.name,
        enabled: r.enabled,
        priority: r.priority,
        mustContain: r.mustContain,
        mustNotContain: r.mustNotContain,
        useRegex: r.useRegex,
        ...(r.episodeFilter ? { episodeFilter: r.episodeFilter } : {}),
        smartEpisodeFilter: r.smartEpisodeFilter,
        ...(r.ignoreSubsequentDays ? { ignoreSubsequentDays: r.ignoreSubsequentDays } : {}),
        feeds: r.assignedFeedIds.flatMap((id) => urlById.get(id) ?? []),
        ...(r.category ? { category: r.category } : {}),
        tags: r.tags,
        savePath: r.savePath ?? '',
        addPaused: r.addPaused,
      })),
    };
  }

  /**
   * Applies an edited document: feeds are matched by URL, rules by id (when given and known)
   * or name. Everything is validated before anything is written, and written in one
   * transaction. New feeds are fetched by the scheduler; existing articles aren't re-matched,
   * so saving never downloads a backlog.
   */
  importConfig(cfg: RssConfigInput, removeMissing: boolean): RssConfigSaveResult {
    const fail = (msg: string): never => {
      throw new CoreError('invalid_input', msg);
    };
    const seenUrls = new Set<string>();
    for (const f of cfg.feeds) {
      if (seenUrls.has(f.url)) fail(`Feed ${f.url} is listed twice`);
      seenUrls.add(f.url);
    }
    const existingFeeds = this.repo.feeds();
    const known = new Set([...seenUrls, ...(removeMissing ? [] : existingFeeds.map((f) => f.url))]);
    const existingRules = this.repo.rules();
    const byId = new Map(existingRules.map((r) => [r.id, r]));
    const byName = new Map(existingRules.map((r) => [r.name, r]));
    const names = new Set<string>();
    const ids = new Set<string>();
    cfg.rules.forEach((r, i) => {
      const where = `Rule ${i + 1} (“${r.name}”)`;
      if (names.has(r.name)) fail(`${where}: another rule has the same name`);
      names.add(r.name);
      if (r.id) {
        if (ids.has(r.id)) fail(`${where}: another rule has the same id`);
        ids.add(r.id);
      }
      const missing = r.feeds.find((u) => !known.has(u));
      if (missing) fail(`${where}: feed ${missing} isn't in "feeds"`);
      try {
        validateRule(r);
      } catch (err) {
        if (err instanceof RuleSyntaxError) fail(`${where}: ${err.message}`);
        throw err;
      }
    });

    const result: RssConfigSaveResult = {
      feeds: { created: 0, updated: 0, deleted: 0 },
      rules: { created: 0, updated: 0, deleted: 0 },
    };
    this.repo.transaction(() => {
      const feedByUrl = new Map(existingFeeds.map((f) => [f.url, f]));
      for (const f of cfg.feeds) {
        const prev = feedByUrl.get(f.url);
        const row: FeedRow = prev
          ? { ...prev }
          : {
              id: randomUUID(),
              url: f.url,
              title: new URL(f.url).host,
              enabled: true,
              refreshMinutes: null,
              lastFetched: null,
              lastError: null,
              nextFetchAt: new Date().toISOString(),
              failures: 0,
              createdAt: new Date().toISOString(),
            };
        row.title = f.title ?? row.title;
        row.enabled = f.enabled;
        row.refreshMinutes = f.refreshMinutes;
        const changed = !prev || canonical(prev) !== canonical(row);
        if (changed) {
          this.repo.saveFeed(row);
          result.feeds[prev ? 'updated' : 'created']++;
        }
        feedByUrl.set(f.url, row);
      }
      if (removeMissing)
        for (const f of existingFeeds)
          if (!seenUrls.has(f.url)) {
            this.repo.deleteFeed(f.id);
            result.feeds.deleted++;
          }

      const kept = new Set<string>();
      for (const r of cfg.rules) {
        const prev = (r.id ? byId.get(r.id) : undefined) ?? byName.get(r.name) ?? null;
        const { id: _id, feeds, ...input } = r;
        const row = toRuleRow(
          { ...input, assignedFeedIds: feeds.map((u) => feedByUrl.get(u)!.id) },
          prev,
        );
        kept.add(row.id);
        if (!prev) {
          this.repo.saveRule(row);
          result.rules.created++;
        } else if (canonical(toRuleDTO(row)) !== canonical(toRuleDTO(prev))) {
          this.repo.saveRule(row);
          result.rules.updated++;
        }
      }
      if (removeMissing)
        for (const r of existingRules)
          if (!kept.has(r.id)) {
            this.repo.deleteRule(r.id);
            result.rules.deleted++;
          }
    });
    this.deps.events.emit('rss:updated', null);
    return result;
  }

  /** Which current articles a (possibly unsaved) rule would match, ignoring history. */
  preview(input: RuleInput): ArticleDTO[] {
    try {
      validateRule(input);
    } catch (err) {
      if (err instanceof RuleSyntaxError) throw new CoreError('invalid_input', err.message);
      throw err;
    }
    const rule = { ...input, id: 'preview', enabled: true };
    return this.repo
      .articles({ limit: 5000 })
      .filter(
        (a) =>
          evaluateRule(rule, a.title, a.feedId, {
            downloadedEpisodes: new Map(),
            lastMatchAt: null,
          }).match,
      )
      .slice(0, 200);
  }

  history(limit?: number): RssHistoryDTO[] {
    return this.repo.history(limit);
  }

  clearHistory(): void {
    this.repo.clearHistory();
  }

  // --- Matching ------------------------------------------------------------------

  private async applyRuleToExisting(rule: RuleRow): Promise<void> {
    const candidates = this.repo
      .articles({ limit: 5000 })
      .filter((a) => !a.downloaded)
      .reverse(); // oldest first, so episode order is natural
    for (const a of candidates) await this.tryRule(rule, a.feedId, a);
  }

  private async processArticles(feedId: string, items: ParsedFeedItem[]): Promise<void> {
    const rules = orderRules(this.repo.rules().filter((r) => r.enabled));
    if (rules.length === 0) return;
    // Oldest first so episodes arrive in order and smart filtering keeps the first copy.
    for (const item of [...items].sort((a, b) => a.pubDate.getTime() - b.pubDate.getTime())) {
      const article = this.repo.article(feedId, item.id);
      if (!article || article.downloaded) continue;
      for (const rule of rules) {
        // Re-read: lastMatchAt / history change as earlier articles are processed.
        if (await this.tryRule(this.repo.rule(rule.id) ?? rule, feedId, article)) break;
      }
    }
  }

  /** Evaluates and, on match, downloads. Returns true if the article was handled by this rule. */
  private async tryRule(rule: RuleRow, feedId: string, article: ArticleDTO): Promise<boolean> {
    if (this.repo.wasDownloaded(feedId, article.id)) return false;
    const decision = evaluateRule(rule, article.title, feedId, {
      downloadedEpisodes: this.repo.downloadedEpisodes(rule.id),
      lastMatchAt: rule.lastMatchAt,
    });
    if (!decision.match) return false;
    this.repo.addMatchedRule(feedId, article.id, rule.id);
    if (!article.torrentURL) return false;

    let status: 'added' | 'duplicate' | 'failed' = 'failed';
    let torrentId: string | null = null;
    let error: string | null = null;
    try {
      const res = await this.addTorrent(
        article.torrentURL,
        {
          origin: 'rss',
          originDetail: rule.name,
          category: rule.category,
          tags: rule.tags,
          savePath: rule.savePath,
          paused: rule.addPaused,
        },
        feedId,
      );
      status = res.status;
      torrentId = res.torrentId;
    } catch (err) {
      error = (err as Error).message;
    }
    this.repo.recordDownload({
      ruleId: rule.id,
      ruleName: rule.name,
      feedId,
      articleId: article.id,
      articleTitle: article.title,
      torrentUrl: article.torrentURL,
      episodeKeys: decision.episodeKeys,
      repack: decision.repack,
      torrentId,
      status,
      error,
    });
    if (status !== 'failed') {
      this.repo.saveRule({ ...rule, lastMatchAt: new Date().toISOString() });
      this.repo.setRead(true, { articles: [{ feedId, id: article.id }] });
      this.deps.events.emit('rss:match', { ruleName: rule.name, title: article.title, status });
    }
    return status !== 'failed';
  }

  private async addTorrent(
    url: string,
    opts: AddOptions,
    feedId: string,
  ): Promise<{ torrentId: string | null; status: 'added' | 'duplicate' }> {
    try {
      if (MAGNET_RE.test(url))
        return { torrentId: this.deps.torrents.addMagnet(url, opts).id, status: 'added' };
      // The link comes from the feed's content: it may only reach the local network when it
      // points at the feed's own (admin-chosen) host, e.g. Prowlarr's download links.
      const feedUrl = this.repo.feed(feedId)?.url;
      const allowPrivate =
        (!!feedUrl && sameHost(feedUrl, url)) || (this.deps.trustsUrl?.(url) ?? false);
      const data = await (this.deps.fetchTorrent ?? defaultFetchTorrent)(url, {
        allowPrivate,
        headers: this.deps.requestHeaders?.(url) ?? {},
      });
      const item = await this.deps.torrents.addTorrentFile(data, opts);
      return { torrentId: item.id, status: 'added' };
    } catch (err) {
      if (err instanceof CoreError && err.code === 'conflict')
        return { torrentId: null, status: 'duplicate' };
      throw err;
    }
  }
}

/** Key-order-independent JSON, ignoring undefined fields (for change detection). */
function canonical(v: object): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(v)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

function toRuleRow(input: RuleInput, existing: RuleRow | null): RuleRow {
  const rule: RuleRow = {
    id: existing?.id ?? randomUUID(),
    name: input.name,
    enabled: input.enabled,
    priority: input.priority,
    mustContain: input.mustContain,
    mustNotContain: input.mustNotContain,
    useRegex: input.useRegex,
    smartEpisodeFilter: input.smartEpisodeFilter,
    assignedFeedIds: input.assignedFeedIds,
    tags: input.tags,
    addPaused: input.addPaused,
    lastMatchAt: existing?.lastMatchAt ?? null,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  if (input.episodeFilter) rule.episodeFilter = input.episodeFilter;
  if (input.ignoreSubsequentDays) rule.ignoreSubsequentDays = input.ignoreSubsequentDays;
  if (input.category) rule.category = input.category;
  if (input.savePath) rule.savePath = input.savePath;
  return rule;
}

function toRuleDTO(r: RuleRow): RuleDTO {
  const { createdAt: _createdAt, ...rest } = r;
  return rest;
}

async function defaultFetchFeed(url: string, extra: Record<string, string>): Promise<string> {
  const { body } = await fetchBytes(url, {
    maxBytes: 8 * 1024 * 1024,
    headers: {
      ...extra,
      accept:
        'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
    },
  });
  return Buffer.from(body).toString('utf8');
}

/** Same scheme-less host (and port) for two URLs. */
export function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase();
  } catch {
    return false;
  }
}

async function defaultFetchTorrent(
  url: string,
  { allowPrivate, headers }: { allowPrivate: boolean; headers: Record<string, string> },
): Promise<Uint8Array> {
  const { body } = await fetchBytes(url, {
    allowPrivate,
    maxBytes: 10 * 1024 * 1024,
    headers: { ...headers, accept: 'application/x-bittorrent, */*' },
  });
  return body;
}
