import type { UpcomingItemDTO, UpcomingResponse } from '@draxmax/shared';
import type { Database } from '../db/database.ts';
import type { CoreEvents } from '../events.ts';
import type { Settings } from '../settings/settings.ts';
import type { TorrentManager } from '../torrent/manager.ts';
import { HttpCache } from './http-cache.ts';
import { Library, type LibraryRow } from './library.ts';
import { bestSimilarity } from './similarity.ts';
import { AniListClient, aniDate, aniPlain, aniTitle, type AniMedia } from './sources/anilist.ts';
import { TMDB_IMAGE, TmdbClient, type TmdbListItem } from './sources/tmdb.ts';

const REFRESH_INTERVAL_MS = 12 * 3600_000;
const DAY = 86_400_000;
/** Minimum title similarity to accept a search hit as the same show/movie. */
const MATCH_THRESHOLD = 0.72;
/**
 * A big library takes a while to link to TMDB/AniList the first time (AniList is rate
 * limited), so a refresh works in rounds of this length and publishes after each one.
 */
const ROUND_MS = 45_000;
/** A source failing this many times in a row is left alone until the next refresh. */
const MAX_CONSECUTIVE_FAILURES = 3;
/** How far ahead New Releases looks for movie and TV premieres. */
const RELEASE_WINDOW_DAYS = 120;
/** AniList formats that count as a season of a show. */
const ANIME_SEASON_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA']);
/** Bumped when For You starts covering more of the library, so the catch-up isn't announced. */
const STORE_VERSION = 2;

export interface UpcomingDeps {
  db: Database;
  torrents: TorrentManager;
  events: CoreEvents;
  settings: () => Settings;
  /** AniList request spacing (tests use 0). */
  anilistIntervalMs?: number;
}

interface Stored {
  v?: number;
  forYou: UpcomingItemDTO[];
  newReleases: UpcomingItemDTO[];
  updatedAt: string | null;
  errors: string[];
}

type Note = (source: string, err: unknown) => void;
type Source = 'tmdb' | 'anilist';
const LABEL: Record<Source, string> = { tmdb: 'TMDB', anilist: 'AniList' };

/** State of one refresh, shared by its rounds. */
interface Run {
  note: Note;
  /** Entries whose lookup failed; not retried until the next refresh. */
  failed: Set<string>;
  /** Entries linked during this refresh: what they bring into For You isn't news. */
  linked: Set<string>;
  /** Sources that kept failing and are skipped for the rest of the refresh. */
  down: Set<Source>;
}

/** Days from now (negative = past). */
function daysUntil(date: string | undefined, now = Date.now()): number | null {
  if (!date) return null;
  const t = Date.parse(date);
  return Number.isNaN(t) ? null : (t - now) / DAY;
}

/** Bonus for being close to its release date, upcoming or just released. */
export function proximityScore(date: string | undefined, now = Date.now()): number {
  const d = daysUntil(date, now);
  if (d === null) return 0;
  if (d >= 0) return d <= 14 ? 20 : d <= 60 ? 12 : d <= 180 ? 5 : 0;
  return -d <= 30 ? 15 : -d <= 90 ? 6 : 0;
}

function statusFor(date: string | undefined, airing = false): UpcomingItemDTO['status'] {
  if (airing) return 'airing';
  const d = daysUntil(date);
  return d !== null && d > 0 ? 'upcoming' : 'released';
}

const plain = (s: string | undefined | null, max = 400) =>
  s ? (s.length > max ? `${s.slice(0, max - 1)}…` : s) : undefined;

/**
 * Builds the two Upcoming lists:
 * - For You: next seasons/episodes, sequels and collection entries for titles in the library.
 * - New Releases: popular upcoming/airing movies, TV and anime, boosted when they resemble the library.
 */
export class UpcomingService {
  readonly library: Library;
  private readonly cache: HttpCache;
  private refreshing: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly deps: UpcomingDeps) {
    this.library = new Library(deps.db);
    this.cache = new HttpCache(deps.db);
  }

  start(): void {
    // First refresh soon after startup if stale, then periodically.
    setTimeout(() => {
      if (this.isStale()) void this.refresh();
    }, 15_000).unref();
    this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
  }

  private stored(): Stored {
    const row = this.deps.db.prepare("SELECT value FROM kv WHERE key = 'upcoming'").get() as
      { value: string } | undefined;
    return row
      ? (JSON.parse(row.value) as Stored)
      : { forYou: [], newReleases: [], updatedAt: null, errors: [] };
  }

  private store(s: Stored): void {
    this.deps.db
      .prepare(
        "INSERT INTO kv (key, value) VALUES ('upcoming', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify(s));
  }

  private isStale(): boolean {
    const { updatedAt, v } = this.stored();
    // Lists built by an older version are redone straight away.
    if (!updatedAt || v !== STORE_VERSION) return true;
    return Date.now() - Date.parse(updatedAt) > REFRESH_INTERVAL_MS;
  }

  private actions(): Map<string, string> {
    const rows = this.deps.db.prepare('SELECT item_id, action FROM upcoming_actions').all() as {
      item_id: string;
      action: string;
    }[];
    return new Map(rows.map((r) => [r.item_id, r.action]));
  }

  /** Current lists with ignored/owned items filtered out. */
  get(): UpcomingResponse {
    const s = this.stored();
    const hidden = this.actions();
    const visible = (items: UpcomingItemDTO[]) => items.filter((i) => !hidden.has(i.id));
    const settings = this.deps.settings();
    return {
      forYou: visible(s.forYou),
      newReleases: visible(s.newReleases),
      updatedAt: s.updatedAt,
      sources: { tmdb: settings.tmdbApiKey !== '', anilist: settings.anilistEnabled },
      library: this.library.progress(settings.tmdbApiKey !== '', settings.anilistEnabled),
      errors: s.errors,
      refreshing: this.refreshing !== null,
    };
  }

  /** "ignore" hides an item; "have" also records it as owned in the library; "reset" undoes both. */
  act(id: string, action: 'ignore' | 'have' | 'reset'): UpcomingResponse {
    if (action === 'reset') {
      this.deps.db.prepare('DELETE FROM upcoming_actions WHERE item_id = ?').run(id);
      return this.get();
    }
    this.deps.db
      .prepare(
        'INSERT INTO upcoming_actions (item_id, action, created_at) VALUES (?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET action = excluded.action',
      )
      .run(id, action, new Date().toISOString());
    if (action === 'have') {
      const s = this.stored();
      const item = [...s.forYou, ...s.newReleases].find((i) => i.id === id);
      if (item) {
        const ext = item.externalIds;
        this.library.addManual(
          item.title,
          item.type,
          item.season ? [item.season] : [],
          item.releaseDate ? Number(item.releaseDate.slice(0, 4)) : null,
          {
            tmdbId: typeof ext.tmdb === 'number' && item.type === 'movie' ? ext.tmdb : null,
            anilistId: typeof ext.anilist === 'number' ? ext.anilist : null,
          },
        );
      }
    }
    return this.get();
  }

  /** Rebuilds the library fingerprint from torrents and folders. */
  async rescanLibrary(): Promise<LibraryRow[]> {
    return this.library.rebuild(this.deps.torrents.list(), this.deps.settings().libraryFolders);
  }

  /** Refreshes both lists. Concurrent calls share one run. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh()
      .catch((err: unknown) => {
        // A refresh still running at shutdown fails once the database closes; that's expected.
        if (!this.closed) throw err;
      })
      .finally(() => {
        this.refreshing = null;
        this.deps.events.emit('upcoming:updated', null);
      });
    this.deps.events.emit('upcoming:updated', null);
    return this.refreshing;
  }

  private clients(): { tmdb: TmdbClient | null; anilist: AniListClient | null } {
    const s = this.deps.settings();
    return {
      tmdb: s.tmdbApiKey ? new TmdbClient(s.tmdbApiKey, this.cache) : null,
      anilist: s.anilistEnabled
        ? new AniListClient(this.cache, s.anilistToken, this.deps.anilistIntervalMs)
        : null,
    };
  }

  private async doRefresh(): Promise<void> {
    const errors: string[] = [];
    const run: Run = {
      note: (source, err) => {
        const msg = `${source}: ${(err as Error).message}`;
        if (!errors.includes(msg)) errors.push(msg);
      },
      failed: new Set(),
      linked: new Set(),
      down: new Set(),
    };
    this.cache.prune();
    await this.rescanLibrary();
    const { tmdb, anilist } = this.clients();
    const prev = this.stored();

    const newReleases: UpcomingItemDTO[] = [];
    if (tmdb) {
      try {
        newReleases.push(...(await this.tmdbReleases(tmdb)));
      } catch (err) {
        run.note('TMDB', err);
      }
    }
    if (anilist) {
      try {
        newReleases.push(...(await this.anilistReleases(anilist)));
      } catch (err) {
        run.note('AniList', err);
      }
    }
    // If a source failed entirely, keep the previous list rather than showing nothing.
    const releases = newReleases.length || !errors.length ? dedupe(newReleases) : prev.newReleases;

    // For You, per source. A source that is switched off contributes nothing.
    const found: Record<Source, UpcomingItemDTO[]> = { tmdb: [], anilist: [] };
    const publish = () => {
      const forYou = dedupe([...found.tmdb, ...found.anilist]).sort(
        (a, b) => b.relevanceScore - a.relevanceScore,
      );
      // Library resemblance boosts general releases; anything already in For You moves there.
      const forYouIds = new Set(forYou.map((i) => i.id));
      const titles = this.library
        .all()
        .filter((e) => !e.hidden)
        .map((e) => e.title);
      const ranked = releases
        .filter((i) => !forYouIds.has(i.id))
        .map((i) => {
          const sim = bestSimilarity(i.title, titles);
          return sim >= 0.6
            ? {
                ...i,
                relevanceScore: i.relevanceScore + Math.round(sim * 25),
                matchedLibraryEntries: [],
              }
            : i;
        })
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .slice(0, 200);
      this.store({
        v: STORE_VERSION,
        forYou,
        newReleases: ranked,
        updatedAt: new Date().toISOString(),
        errors,
      });
      this.announceNew(this.get().forYou, run.linked, prev.v !== STORE_VERSION);
      this.deps.events.emit('upcoming:updated', null);
    };

    // Each source links a batch of library entries, checks what's new for everything it
    // has linked, and publishes; a slow source never holds up the other.
    const work = async (source: Source, client: TmdbClient | AniListClient | null) => {
      if (!client) return;
      // Until its first round is through, a source keeps showing what it found last time.
      found[source] = prev.forYou.filter((i) => i.source === source);
      for (;;) {
        const pending = await this.linkEntries(source, client, run, Date.now() + ROUND_MS);
        if (this.closed) return;
        found[source] = await this.forYouFrom(source, client, run, found[source]);
        if (this.closed) return;
        publish();
        if (!pending) return;
      }
    };
    await Promise.all([work('tmdb', tmdb), work('anilist', anilist)]);
    if (!tmdb && !anilist) publish();
  }

  /** For You items for every library entry linked to `source`. */
  private async forYouFrom(
    source: Source,
    client: TmdbClient | AniListClient,
    run: Run,
    previous: UpcomingItemDTO[],
  ): Promise<UpcomingItemDTO[]> {
    const entries = this.library.all().filter((e) => !e.hidden);
    // The same show under two names ("House Of Dragon", "House of the Dragon") is one show.
    const targets = new Map<string, LibraryRow>();
    for (const e of entries) {
      const id =
        client instanceof TmdbClient
          ? e.tmdbId && (e.type === 'tv' || e.type === 'movie') && `${e.type}:${e.tmdbId}`
          : e.anilistId && String(e.anilistId);
      if (!id) continue;
      const same = targets.get(id);
      targets.set(
        id,
        same ? { ...same, seasonsOwned: [...same.seasonsOwned, ...e.seasonsOwned] } : e,
      );
    }
    const ownedMovies = new Set(
      entries.filter((e) => e.type === 'movie' && e.tmdbId).map((e) => e.tmdbId!),
    );
    const ownedAnime = new Set(entries.filter((e) => e.anilistId).map((e) => e.anilistId!));

    const out: UpcomingItemDTO[] = [];
    let failures = 0;
    for (const e of targets.values()) {
      if (this.closed || run.down.has(source)) break;
      try {
        out.push(
          ...(client instanceof AniListClient
            ? await this.animeForYou(client, e, ownedAnime)
            : e.type === 'tv'
              ? await this.tvForYou(client, e)
              : await this.movieForYou(client, e, ownedMovies)),
        );
        failures = 0;
      } catch (err) {
        run.note(LABEL[source], err);
        if (++failures >= MAX_CONSECUTIVE_FAILURES) run.down.add(source);
      }
    }
    // A source that went down keeps what it found last time.
    return run.down.has(source) ? dedupe([...out, ...previous]) : out;
  }

  /**
   * Emits For You items not seen before (new season, sequel, …). What's there on the first
   * run, or comes from entries linked just now, is only recorded, so an existing library
   * doesn't flood the notification history.
   */
  private announceNew(
    items: UpcomingItemDTO[],
    justLinked: ReadonlySet<string> = new Set(),
    baseline = false,
  ): void {
    const row = this.deps.db.prepare("SELECT value FROM kv WHERE key = 'upcoming_seen'").get() as
      { value: string } | undefined;
    const seen = new Set<string>(row ? (JSON.parse(row.value) as string[]) : []);
    const fresh =
      row && !baseline
        ? items.filter(
            (i) => !seen.has(i.id) && !i.matchedLibraryEntries.some((id) => justLinked.has(id)),
          )
        : [];
    for (const i of items) seen.add(i.id);
    this.deps.db
      .prepare(
        "INSERT INTO kv (key, value) VALUES ('upcoming_seen', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(JSON.stringify([...seen].slice(-5000)));
    if (fresh.length) this.deps.events.emit('upcoming:new', fresh);
  }

  /**
   * Links library entries to `source` ids (once per entry) until `deadline`. Returns how
   * many entries are still waiting.
   */
  private async linkEntries(
    source: Source,
    client: TmdbClient | AniListClient,
    run: Run,
    deadline: number,
  ): Promise<number> {
    const todo = this.library
      .all()
      .filter((e) => !e.hidden && !e.lookupDone && !run.failed.has(e.id))
      .filter((e) =>
        client instanceof TmdbClient
          ? !e.tmdbId && (e.type === 'tv' || e.type === 'movie')
          : !e.anilistId && e.type === 'anime',
      )
      // Shows first: they are few and bring the most into For You.
      .sort((a, b) => Number(b.type === 'tv') - Number(a.type === 'tv'));
    let failures = 0;
    let left = todo.length;
    for (const e of todo) {
      if (this.closed || run.down.has(source)) return 0;
      try {
        if (client instanceof TmdbClient) await this.linkTmdb(client, e);
        else await this.linkAniList(client, e);
        e.lookupDone = true;
        this.library.save(e);
        if (e.tmdbId || e.anilistId) run.linked.add(e.id);
        failures = 0;
      } catch (err) {
        run.note(LABEL[source], err);
        run.failed.add(e.id);
        // A bad key or an outage would fail every lookup; stop early.
        if (
          ++failures >= MAX_CONSECUTIVE_FAILURES ||
          /rejected the API key/.test((err as Error).message)
        ) {
          run.down.add(source);
          return 0;
        }
      }
      left--;
      if (Date.now() >= deadline) break;
    }
    return left;
  }

  private async linkTmdb(tmdb: TmdbClient, e: LibraryRow): Promise<void> {
    const search = (year?: number) =>
      e.type === 'tv' ? tmdb.searchTv(e.title, year) : tmdb.searchMovie(e.title, year);
    const pick = (results: Awaited<ReturnType<typeof search>>) =>
      results
        .map((r) => ({
          r,
          s: bestSimilarity(e.title, [r.name, r.title, r.original_name, r.original_title]),
        }))
        .filter((x) => x.s >= MATCH_THRESHOLD)
        .sort((a, b) => b.s - a.s || (b.r.popularity ?? 0) - (a.r.popularity ?? 0))[0];
    // Release names are often a year off from TMDB's date; fall back to any year.
    const best =
      pick(await search(e.year ?? undefined)) ?? (e.year ? pick(await search()) : undefined);
    if (best) e.tmdbId = best.r.id;
  }

  private async linkAniList(anilist: AniListClient, e: LibraryRow): Promise<void> {
    const best = (await anilist.search(e.title))
      .map((m) => ({
        m,
        s: bestSimilarity(e.title, [m.title.english, m.title.romaji, ...(m.synonyms ?? [])]),
      }))
      .filter((x) => x.s >= MATCH_THRESHOLD)
      .sort((a, b) => b.s - a.s)[0];
    if (best) e.anilistId = best.m.id;
  }

  private async tvForYou(tmdb: TmdbClient, e: LibraryRow): Promise<UpcomingItemDTO[]> {
    const show = await tmdb.tv(e.tmdbId!);
    const last = e.seasonsOwned.length ? Math.max(...e.seasonsOwned) : 0;
    const base = {
      title: show.name,
      type: 'tv' as const,
      posterUrl: show.poster_path ? TMDB_IMAGE + show.poster_path : undefined,
      overview: plain(show.overview),
      matchedLibraryEntries: [e.id],
      source: 'tmdb' as const,
      popularity: show.popularity ?? 0,
    };
    const out: UpcomingItemDTO[] = [];
    // Seasons after the last one owned that have aired or have a date.
    for (const s of show.seasons ?? []) {
      if (s.season_number <= last || s.season_number === 0 || !s.air_date) continue;
      const released = (daysUntil(s.air_date) ?? 0) <= 0;
      out.push(
        clean({
          ...base,
          id: `tmdb-tv-${show.id}-s${s.season_number}`,
          posterUrl: s.poster_path ? TMDB_IMAGE + s.poster_path : base.posterUrl,
          overview: plain(s.overview) ?? base.overview,
          releaseDate: s.air_date,
          season: s.season_number,
          status: statusFor(s.air_date),
          reason: released
            ? `Season ${s.season_number} of ${show.name} is out — you have up to season ${last || '?'}`
            : `Season ${s.season_number} of ${show.name} premieres`,
          relevanceScore: (s.season_number === last + 1 ? 100 : 80) + proximityScore(s.air_date),
          externalIds: { tmdb: show.id },
        }),
      );
    }
    // The season currently airing that the user follows: next episode.
    const next = show.next_episode_to_air;
    if (next && next.season_number <= last && next.air_date) {
      out.push(
        clean({
          ...base,
          id: `tmdb-tv-${show.id}-s${next.season_number}e${next.episode_number}`,
          releaseDate: next.air_date,
          season: next.season_number,
          episode: next.episode_number,
          status: 'airing',
          reason: `New episode S${String(next.season_number).padStart(2, '0')}E${String(next.episode_number).padStart(2, '0')}${next.name ? ` “${next.name}”` : ''}`,
          relevanceScore: 85 + proximityScore(next.air_date),
          externalIds: { tmdb: show.id },
        }),
      );
    }
    return out;
  }

  private async movieForYou(
    tmdb: TmdbClient,
    e: LibraryRow,
    ownedMovies: Set<number>,
  ): Promise<UpcomingItemDTO[]> {
    const movie = await tmdb.movie(e.tmdbId!);
    const col = movie.belongs_to_collection;
    if (!col) return [];
    const collection = await tmdb.collection(col.id);
    return collection.parts
      .filter((p) => !ownedMovies.has(p.id) && p.id !== movie.id && p.release_date)
      .filter((p) => (daysUntil(p.release_date) ?? -9999) > -365 * 3)
      .map((p) =>
        clean({
          id: `tmdb-movie-${p.id}`,
          title: p.title,
          type: 'movie',
          posterUrl: p.poster_path ? TMDB_IMAGE + p.poster_path : undefined,
          releaseDate: p.release_date,
          overview: plain(p.overview),
          relevanceScore: 70 + proximityScore(p.release_date),
          matchedLibraryEntries: [e.id],
          source: 'tmdb',
          externalIds: { tmdb: p.id },
          reason: `From ${col.name}, which includes ${movie.title}`,
          popularity: p.popularity ?? 0,
          status: statusFor(p.release_date),
        }),
      );
  }

  private async animeForYou(
    anilist: AniListClient,
    e: LibraryRow,
    ownedAnime: Set<number>,
  ): Promise<UpcomingItemDTO[]> {
    let media = await anilist.withRelations(e.anilistId!);
    // AniList lists every season as its own entry: step past the ones already owned.
    const lastOwned = Math.min(e.seasonsOwned.length ? Math.max(...e.seasonsOwned) : 1, 20);
    for (let season = 1; season < lastOwned; season++) {
      const next = media.relations?.edges.find(
        (x) => x.relationType === 'SEQUEL' && ANIME_SEASON_FORMATS.has(x.node.format ?? ''),
      );
      if (!next || next.node.status === 'NOT_YET_RELEASED') break;
      media = await anilist.withRelations(next.node.id);
    }
    const out: UpcomingItemDTO[] = [];
    const toItem = (
      m: AniMedia,
      score: number,
      reason: string,
      extra: Partial<UpcomingItemDTO> = {},
    ) =>
      clean({
        id: `anilist-${m.id}`,
        title: aniTitle(m),
        type: 'anime',
        posterUrl: m.coverImage?.extraLarge ?? m.coverImage?.large ?? undefined,
        releaseDate: m.nextAiringEpisode
          ? new Date(m.nextAiringEpisode.airingAt * 1000).toISOString().slice(0, 10)
          : aniDate(m.startDate),
        overview: plain(aniPlain(m.description)),
        relevanceScore: score,
        matchedLibraryEntries: [e.id],
        source: 'anilist',
        externalIds: { anilist: m.id },
        reason,
        popularity: m.popularity ?? 0,
        status:
          m.status === 'RELEASING'
            ? 'airing'
            : m.status === 'NOT_YET_RELEASED'
              ? 'upcoming'
              : 'released',
        ...extra,
      });
    for (const edge of media.relations?.edges ?? []) {
      const n = edge.node;
      if (edge.relationType !== 'SEQUEL' || ownedAnime.has(n.id)) continue;
      if (!['NOT_YET_RELEASED', 'RELEASING', 'FINISHED'].includes(n.status ?? '')) continue;
      const date = aniDate(n.startDate);
      // Long-finished sequels are still relevant if the user doesn't have them, but rank lower.
      const recent = n.status !== 'FINISHED' || (daysUntil(date) ?? -9999) > -365;
      out.push(
        toItem(n, (recent ? 95 : 60) + proximityScore(date), `Sequel to ${aniTitle(media)}`),
      );
    }
    if (media.status === 'RELEASING' && media.nextAiringEpisode) {
      const ep = media.nextAiringEpisode;
      out.push(
        toItem(
          media,
          85 + proximityScore(new Date(ep.airingAt * 1000).toISOString()),
          `Episode ${ep.episode} airs ${new Date(ep.airingAt * 1000).toLocaleDateString()}`,
          {
            id: `anilist-${media.id}-e${ep.episode}`,
            episode: ep.episode,
          },
        ),
      );
    }
    return out;
  }

  private async tmdbReleases(tmdb: TmdbClient): Promise<UpcomingItemDTO[]> {
    // TMDB's own "upcoming" list is mostly films already out, so ask for the dates we mean.
    const from = new Date(Date.now() + DAY).toISOString().slice(0, 10);
    const to = new Date(Date.now() + RELEASE_WINDOW_DAYS * DAY).toISOString().slice(0, 10);
    const [upcoming, upcoming2, nowPlaying, onAir, premieres] = await Promise.all([
      tmdb.discover('movie', from, to, 1),
      tmdb.discover('movie', from, to, 2),
      tmdb.list('/movie/now_playing'),
      tmdb.list('/tv/on_the_air'),
      tmdb.discover('tv', from, to, 1),
    ]);
    upcoming.push(...upcoming2);
    const maxPop = Math.max(
      1,
      ...[...upcoming, ...nowPlaying, ...onAir, ...premieres].map((i) => i.popularity ?? 0),
    );
    const mk = (i: TmdbListItem, type: 'movie' | 'tv', premiere = false): UpcomingItemDTO => {
      const date = type === 'movie' ? i.release_date : i.first_air_date;
      return clean({
        id: `tmdb-${type}-${i.id}`,
        title: (type === 'movie' ? i.title : i.name) ?? `#${i.id}`,
        type,
        posterUrl: i.poster_path ? TMDB_IMAGE + i.poster_path : undefined,
        releaseDate: date,
        overview: plain(i.overview),
        relevanceScore: Math.round(((i.popularity ?? 0) / maxPop) * 50) + proximityScore(date),
        matchedLibraryEntries: [],
        source: 'tmdb',
        externalIds: { tmdb: i.id },
        popularity: i.popularity ?? 0,
        status: statusFor(date, type === 'tv' && !premiere),
      });
    };
    return [
      ...upcoming.map((i) => mk(i, 'movie')),
      ...nowPlaying.map((i) => mk(i, 'movie')),
      ...onAir.map((i) => mk(i, 'tv')),
      ...premieres.map((i) => mk(i, 'tv', true)),
    ];
  }

  private async anilistReleases(anilist: AniListClient): Promise<UpcomingItemDTO[]> {
    const [airing, upcoming] = await Promise.all([
      anilist.list({ status: 'RELEASING' }),
      anilist.list({ status: 'NOT_YET_RELEASED' }),
    ]);
    const maxPop = Math.max(1, ...[...airing, ...upcoming].map((m) => m.popularity ?? 0));
    return [...airing, ...upcoming].map((m) => {
      const date = m.nextAiringEpisode
        ? new Date(m.nextAiringEpisode.airingAt * 1000).toISOString().slice(0, 10)
        : aniDate(m.startDate);
      return clean({
        id: `anilist-${m.id}`,
        title: aniTitle(m),
        type: 'anime',
        posterUrl: m.coverImage?.extraLarge ?? m.coverImage?.large ?? undefined,
        releaseDate: date,
        overview: plain(aniPlain(m.description)),
        relevanceScore: Math.round(((m.popularity ?? 0) / maxPop) * 50) + proximityScore(date),
        matchedLibraryEntries: [],
        source: 'anilist',
        externalIds: { anilist: m.id },
        popularity: m.popularity ?? 0,
        status: m.status === 'RELEASING' ? 'airing' : 'upcoming',
        ...(m.nextAiringEpisode ? { episode: m.nextAiringEpisode.episode } : {}),
      });
    });
  }
}

/** Drops undefined optional fields (exact optional types on the wire). */
function clean(i: Record<string, unknown>): UpcomingItemDTO {
  return Object.fromEntries(
    Object.entries(i).filter(([, v]) => v !== undefined),
  ) as unknown as UpcomingItemDTO;
}

/** Keeps the highest-scored copy of each id. */
function dedupe(items: UpcomingItemDTO[]): UpcomingItemDTO[] {
  const best = new Map<string, UpcomingItemDTO>();
  for (const i of items) {
    const prev = best.get(i.id);
    if (!prev || prev.relevanceScore < i.relevanceScore) best.set(i.id, i);
  }
  return [...best.values()];
}
