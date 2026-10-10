import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { MissingResponse, MissingShowDTO, TorrentItem } from '@draxmax/shared';
import { MAGNET_RE } from '@draxmax/shared';
import type { Database } from '../db/database.ts';
import { CoreError } from '../errors.ts';
import type { CoreEvents } from '../events.ts';
import { fetchBytes } from '../net/http.ts';
import type { RssRepository, RuleRow } from '../rss/rss-repo.ts';
import { sameHost } from '../rss/rss-service.ts';
import type { SiteService } from '../sites/site-service.ts';
import type { Settings } from '../settings/settings.ts';
import type { TorrentManager } from '../torrent/manager.ts';
import {
  episodesFromKeys,
  episodesOf,
  inferIdentity,
  planDownloads,
  searchQuery,
  type Identity,
} from './plan.ts';
import { matchesText } from '../rss/rules.ts';
import type { AddOptions } from '../torrent/manager.ts';
import {
  animeToshoSource,
  defaultFetchText,
  nyaaSource,
  parseTorznabUrls,
  sourceCarries,
  torznabSource,
  type FetchText,
  type SearchResult,
  type SearchSource,
} from './sources.ts';

const HOUR = 3600_000;
const TICK_MS = 15 * 60_000;
const FIRST_RUN_DELAY_MS = 2 * 60_000;
/** Shows without a match for this long are checked weekly instead. */
const ACTIVE_WINDOW_MS = 30 * 24 * HOUR;
const IDLE_INTERVAL_MS = 7 * 24 * HOUR;
const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|webm)$/i;
const SCAN_DEPTH = 2;
/** History feed id for torrents added by this service. */
export const MISSING_FEED_ID = 'missing';

export interface MissingDeps {
  db: Database;
  repo: RssRepository;
  torrents: TorrentManager;
  events: CoreEvents;
  settings: () => Settings;
  /** Injected for tests. */
  fetchText?: FetchText;
  fetchTorrent?: (
    url: string,
    opts: { allowPrivate: boolean; headers: Record<string, string> },
  ) => Promise<Uint8Array>;
  /** User-configured tracker sites: extra search sources, cookies for their downloads. */
  sites?: Pick<SiteService, 'sources' | 'headersFor' | 'ownsUrl'>;
  /** Spacing between requests to one source (tests use 0). */
  sourceIntervalMs?: number;
}

interface Stored {
  shows: Record<string, MissingShowDTO>;
  lastRunAt: string | null;
  lastRunAdded: number;
}

/** Video file names under a folder (a few levels deep); missing folders count as empty. */
async function listVideos(root: string, depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > SCAN_DEPTH) return out;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) await listVideos(join(root, e.name), depth + 1, out);
    else if (VIDEO_EXT.test(e.name) && !/sample/i.test(e.name)) out.push(e.name);
  }
  return out;
}

const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, '') === b.replace(/[\\/]+$/, '');

/**
 * Fills gaps that RSS can't: feeds only carry the latest items, so episodes released while
 * DraxMax was down (or before a rule existed) never show up. For every enabled rule with a
 * save folder, this works out which show/season the folder holds and which episodes it has,
 * searches indexers with the rule's own query and filters, and adds the released episodes
 * that are missing — newer ones and gaps after the first episode owned.
 */
export class MissingService {
  private running: Promise<void> | null = null;
  /** Sources that failed during the current run (name → error), for the run summary. */
  private runErrors = new Map<string, string>();
  private current: string | null = null;
  private timers: NodeJS.Timeout[] = [];
  private closed = false;

  constructor(private readonly deps: MissingDeps) {}

  start(): void {
    this.timers.push(setTimeout(() => void this.run(), FIRST_RUN_DELAY_MS).unref());
    this.timers.push(setInterval(() => void this.run(), TICK_MS).unref());
  }

  stop(): void {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
  }

  private stored(): Stored {
    const row = this.deps.db.prepare("SELECT value FROM kv WHERE key = 'missing'").get() as
      { value: string } | undefined;
    return row
      ? (JSON.parse(row.value) as Stored)
      : { shows: {}, lastRunAt: null, lastRunAdded: 0 };
  }

  private store(s: Stored): void {
    this.deps.db
      .prepare(
        "INSERT INTO kv (key, value) VALUES ('missing', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(s));
  }

  /** Every enabled search source: built-in indexers, Torznab endpoints and sites. */
  sources(): SearchSource[] {
    const s = this.deps.settings();
    const fetchText = this.deps.fetchText ?? defaultFetchText;
    const gap = this.deps.sourceIntervalMs;
    return [
      ...(s.missingUseNyaa ? [nyaaSource(fetchText, gap)] : []),
      ...(s.missingUseAnimeTosho ? [animeToshoSource(fetchText, gap)] : []),
      ...parseTorznabUrls(s.torznabUrls).map((u) => torznabSource(u, fetchText, gap)),
      ...(this.deps.sites?.sources() ?? []),
    ];
  }

  /** Rules that can be checked: enabled, with a save folder, and not opted out. */
  private rules(): RuleRow[] {
    return this.deps.repo
      .rules()
      .filter((r) => r.enabled && r.savePath?.trim() && r.missingMode !== 'off');
  }

  get(): MissingResponse {
    const s = this.stored();
    const shows = this.rules().map(
      (r): MissingShowDTO =>
        s.shows[r.id] ?? {
          ruleId: r.id,
          ruleName: r.name,
          savePath: r.savePath!,
          title: null,
          season: null,
          have: [],
          missing: [],
          added: [],
          unavailable: [],
          state: 'pending',
          message: null,
          checkedAt: null,
          nextCheckAt: null,
        },
    );
    const order = { missing: 0, error: 1, 'no-results': 2, pending: 3, empty: 4, ok: 5 };
    shows.sort((a, b) => order[a.state] - order[b.state] || a.ruleName.localeCompare(b.ruleName));
    return {
      enabled: this.deps.settings().missingEnabled,
      shows,
      sources: this.sources().map((x) => x.name),
      running: this.running !== null,
      current: this.current,
      lastRunAt: s.lastRunAt,
      lastRunAdded: s.lastRunAdded,
      noFolder: this.deps.repo
        .rules()
        .filter((r) => r.enabled && !r.savePath?.trim() && r.missingMode !== 'off').length,
      whenEmpty: this.deps.settings().missingWhenEmpty,
    };
  }

  /**
   * Checks due shows (or the given rules / everything with `force`). Scheduled runs only
   * happen while the feature is enabled; concurrent calls share one run.
   */
  run(opts: { force?: boolean; ruleIds?: string[] } = {}): Promise<void> {
    if (this.running) return this.running;
    if (!opts.force && !opts.ruleIds && !this.deps.settings().missingEnabled)
      return Promise.resolve();
    this.running = this.doRun(opts)
      .catch((err: unknown) => {
        // The database closes under a run still going at shutdown; that's expected.
        if (!this.closed) throw err;
      })
      .finally(() => {
        this.running = null;
        this.current = null;
        if (!this.closed) this.deps.events.emit('missing:updated', null);
      });
    this.deps.events.emit('missing:updated', null);
    return this.running;
  }

  private async doRun(opts: { force?: boolean; ruleIds?: string[] }): Promise<void> {
    const sources = this.sources();
    if (sources.length === 0) return;
    this.runErrors = new Map();
    const settings = this.deps.settings();
    const now = Date.now();
    const state = this.stored();
    const rules = this.rules();
    const due = rules.filter((r) => {
      if (opts.ruleIds) return opts.ruleIds.includes(r.id);
      const next = state.shows[r.id]?.nextCheckAt;
      return opts.force || !next || Date.parse(next) <= now;
    });
    let budget = settings.missingMaxPerRun;
    let added = 0;
    const torrents = this.deps.torrents.list();
    for (const rule of due) {
      if (this.closed) return;
      this.current = rule.name;
      this.deps.events.emit('missing:updated', null);
      const show = await this.checkRule(rule, sources, torrents, budget, settings);
      budget -= show.added.length;
      added += show.added.length;
      // Re-read: the history and other state may have changed while searching.
      const latest = this.stored();
      latest.shows[rule.id] = show;
      this.store(latest);
    }
    const final = this.stored();
    const known = new Set(rules.map((r) => r.id));
    final.shows = Object.fromEntries(Object.entries(final.shows).filter(([id]) => known.has(id)));
    if (due.length) {
      final.lastRunAt = new Date().toISOString();
      final.lastRunAdded = added;
    }
    this.store(final);
    if (due.length)
      this.deps.events.emit('missing:run', {
        added,
        failing: [...this.runErrors].map(([source, error]) => ({ source, error })),
      });
  }

  private async checkRule(
    rule: RuleRow,
    sources: SearchSource[],
    torrents: TorrentItem[],
    budget: number,
    settings: Settings,
  ): Promise<MissingShowDTO> {
    const savePath = rule.savePath!;
    const active = Date.now() - Date.parse(rule.lastMatchAt ?? rule.createdAt) < ACTIVE_WINDOW_MS;
    const next = (ms: number) => new Date(Date.now() + ms).toISOString();
    const base: MissingShowDTO = {
      ruleId: rule.id,
      ruleName: rule.name,
      savePath,
      title: null,
      season: null,
      have: [],
      missing: [],
      added: [],
      unavailable: [],
      state: 'ok',
      message: null,
      checkedAt: new Date().toISOString(),
      nextCheckAt: next(active ? settings.missingIntervalHours * HOUR : IDLE_INTERVAL_MS),
    };

    const onDisk = await listVideos(savePath);
    const inClient = torrents
      .filter((t) => samePath(t.savePath, savePath))
      .flatMap((t) => [t.name, ...t.files.map((f) => basename(f.path || f.name))]);
    const names = [...onDisk, ...inClient];
    const mode = rule.missingMode ?? 'default';
    let id = inferIdentity(names);
    // An empty folder has nothing to compare against. Either wait for RSS to bring the first
    // episode, or (per rule, or by the global setting) fetch the season from episode 1.
    const fromStart =
      mode === 'all' || (!id && mode === 'default' && settings.missingWhenEmpty === 'download');
    if (!id && !fromStart)
      return {
        ...base,
        state: 'empty',
        message:
          'No episodes in this folder yet: waiting for the first one from RSS. To fetch the season from episode 1 instead, set “Missing episodes” on the rule to “Whole season”.',
      };

    // Without files the kind of show is a guess from the folder and category names.
    const kind = id
      ? id.anime
        ? 'anime'
        : 'tv'
      : /anime/i.test(`${savePath} ${rule.category ?? ''}`)
        ? 'anime'
        : null;
    const query = searchQuery(rule, id);
    const results: SearchResult[] = [];
    const errors: string[] = [];
    const usable = sources.filter((s) =>
      kind ? sourceCarries(s, kind) : sourceCarries(s, 'anime') || sourceCarries(s, 'tv'),
    );
    for (const source of usable) {
      try {
        results.push(...(await source.search(query)));
      } catch (err) {
        errors.push(`${source.name}: ${(err as Error).message}`);
        this.runErrors.set(source.name, (err as Error).message);
      }
    }
    const retry = next(settings.missingIntervalHours * HOUR);
    if (usable.length === 0)
      return {
        ...base,
        title: id?.title ?? null,
        season: id?.season ?? null,
        state: 'error',
        message:
          kind === 'anime'
            ? 'No enabled search source carries anime. Add or enable one under Sites.'
            : 'Live-action shows need a Torznab indexer (Prowlarr or Jackett) or a site that carries TV. Add one under Sites.',
      };
    if (errors.length === usable.length)
      return {
        ...base,
        title: id?.title ?? null,
        season: id?.season ?? null,
        state: 'error',
        message: errors.join(' · '),
        nextCheckAt: retry,
      };
    // The show is whatever the rule's own filters pick out of the results.
    id ??= inferIdentity(results.filter((r) => matchesText(rule, r.title)).map((r) => r.title));
    if (!id)
      return {
        ...base,
        state: 'no-results',
        message: `Nothing matching this rule was found for “${query}”, so the show couldn't be identified yet.`,
      };

    const have = episodesOf(names, id);
    for (const e of episodesFromKeys(this.deps.repo.downloadedEpisodes(rule.id).keys(), id))
      have.add(e);
    const shown = { ...base, title: id.title, season: id.season, have: sorted(have) };

    const plan = planDownloads(results, rule, id, have, {
      minSeeders: settings.missingMinSeeders,
      fromStart,
    });
    const addedEps: number[] = [];
    const deferred: number[] = [];
    for (const d of plan.downloads) {
      if (addedEps.length >= budget || budget <= 0) {
        deferred.push(...d.episodes);
        continue;
      }
      if (await this.download(rule, id, d.result, d.episodes)) addedEps.push(...d.episodes);
      else deferred.push(...d.episodes);
    }
    const unavailable = sorted(new Set([...plan.unavailable, ...deferred]));
    return {
      ...shown,
      missing: plan.missing,
      added: sorted(new Set(addedEps)),
      unavailable,
      state: unavailable.length ? 'missing' : plan.released.length ? 'ok' : 'no-results',
      message:
        (plan.released.length === 0
          ? `No releases of ${id.title}${id.season > 1 ? ` season ${id.season}` : ''} matching this rule were found for “${query}”.`
          : null) ?? (errors.length ? errors.join(' · ') : null),
      // Come back soon when work is left over (budget, unseeded releases).
      nextCheckAt: unavailable.length
        ? next(settings.missingIntervalHours * HOUR)
        : base.nextCheckAt,
    };
  }

  /**
   * Adds a search result to the client: a magnet as is, a .torrent link fetched with the
   * credentials of the site or indexer it belongs to. Throws `conflict` if it's in the list.
   */
  async addResult(result: SearchResult, opts: AddOptions): Promise<TorrentItem> {
    if (MAGNET_RE.test(result.url)) return this.deps.torrents.addMagnet(result.url, opts);
    // Result links come from indexer content: only a configured Torznab endpoint's own
    // host (or a configured site) may be on the local network.
    const allowPrivate =
      parseTorznabUrls(this.deps.settings().torznabUrls).some((u) => sameHost(u, result.url)) ||
      (this.deps.sites?.ownsUrl(result.url) ?? false);
    const data = await (this.deps.fetchTorrent ?? defaultFetchTorrent)(result.url, {
      allowPrivate,
      // A site's download link needs its passkey (in the URL) and often its session.
      headers: this.deps.sites?.headersFor(result.url) ?? {},
    });
    return this.deps.torrents.addTorrentFile(data, opts);
  }

  /** Adds one release to the client and records it in the RSS history. True if added or already there. */
  private async download(
    rule: RuleRow,
    id: Identity,
    result: SearchResult,
    episodes: number[],
  ): Promise<boolean> {
    let status: 'added' | 'duplicate' | 'failed' = 'failed';
    let torrentId: string | null = null;
    let error: string | null = null;
    try {
      torrentId = (
        await this.addResult(result, {
          origin: 'missing',
          originDetail: rule.name,
          category: rule.category ?? result.category,
          tags: rule.tags,
          savePath: rule.savePath,
          paused: rule.addPaused,
        })
      ).id;
      status = 'added';
    } catch (err) {
      if (err instanceof CoreError && err.code === 'conflict') status = 'duplicate';
      else error = (err as Error).message;
    }
    this.deps.repo.recordDownload({
      ruleId: rule.id,
      ruleName: rule.name,
      feedId: MISSING_FEED_ID,
      articleId: result.url.slice(0, 512),
      articleTitle: result.title,
      torrentUrl: result.url,
      episodeKeys: episodes.map((e) => `${id.key}|s${id.season}e${e}`),
      repack: false,
      torrentId,
      status,
      error,
    });
    if (status !== 'failed')
      this.deps.events.emit('rss:match', {
        ruleName: `${rule.name} (missing episode)`,
        title: result.title,
        status,
      });
    return status !== 'failed';
  }
}

const sorted = (s: Iterable<number>) => [...s].sort((a, b) => a - b);

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
