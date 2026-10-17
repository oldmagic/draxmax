import { fetchJson, HttpError } from '../../net/http.ts';
import type { HttpCache } from '../http-cache.ts';

const API = 'https://graphql.anilist.co';
const HOUR = 3600_000;
/** AniList allows 30 requests/minute at present (90 at best); stay under it. */
const MIN_INTERVAL_MS = 2_500;
/** How often one request waits out a 429 before giving up. */
const MAX_RATE_LIMIT_RETRIES = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AniDate {
  year?: number | null;
  month?: number | null;
  day?: number | null;
}

export interface AniMedia {
  id: number;
  title: { romaji?: string | null; english?: string | null; native?: string | null };
  format?: string | null;
  status?: 'FINISHED' | 'RELEASING' | 'NOT_YET_RELEASED' | 'CANCELLED' | 'HIATUS' | null;
  season?: string | null;
  seasonYear?: number | null;
  startDate?: AniDate | null;
  coverImage?: { large?: string | null; extraLarge?: string | null } | null;
  description?: string | null;
  popularity?: number | null;
  nextAiringEpisode?: { airingAt: number; episode: number } | null;
  synonyms?: string[] | null;
  relations?: { edges: { relationType: string; node: AniMedia }[] } | null;
}

const FIELDS = `id title { romaji english native } format status season seasonYear startDate { year month day }
  coverImage { large extraLarge } description(asHtml: false) popularity nextAiringEpisode { airingAt episode } synonyms`;

/** Minimal AniList GraphQL client with request pacing and caching. Works without a token. */
export class AniListClient {
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;
  /** Current request spacing; grows when AniList pushes back. */
  private intervalMs: number;

  constructor(
    private readonly cache: HttpCache,
    private readonly token = '',
    minIntervalMs = MIN_INTERVAL_MS,
  ) {
    this.intervalMs = minIntervalMs;
  }

  private async query<T>(
    query: string,
    variables: Record<string, unknown>,
    ttlMs: number | ((data: T) => number),
  ): Promise<T> {
    const key = `anilist:${JSON.stringify([query.replace(/\s+/g, ' '), variables])}`;
    const hit = this.cache.get<T>(key);
    if (hit !== undefined) return hit;
    // Serialise and pace live requests.
    const run = this.queue.then(async () => {
      const send = async () => {
        const wait = this.last + this.intervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        this.last = Date.now();
        return fetchJson<{ data?: T; errors?: { message: string }[] }>(API, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          },
          body: JSON.stringify({ query, variables }),
          timeoutMs: 15_000,
        });
      };
      let res;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await send();
          break;
        } catch (err) {
          if (
            !(err instanceof HttpError) ||
            err.status !== 429 ||
            attempt >= MAX_RATE_LIMIT_RETRIES
          )
            throw err;
          // Rate limited: sit out the window AniList names, then go slower from here on.
          this.intervalMs = Math.min(Math.max(this.intervalMs, MIN_INTERVAL_MS) * 1.5, 8_000);
          await sleep(Math.min(err.retryAfter ?? 60, 120) * 1000);
        }
      }
      if (res.errors?.length || !res.data)
        throw new Error(`AniList: ${res.errors?.[0]?.message ?? 'empty response'}`);
      this.cache.set(key, res.data, typeof ttlMs === 'number' ? ttlMs : ttlMs(res.data));
      return res.data;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async search(title: string): Promise<AniMedia[]> {
    const data = await this.query<{ Page: { media: AniMedia[] } }>(
      `query ($q: String) { Page(perPage: 5) { media(search: $q, type: ANIME, isAdult: false) { ${FIELDS} } } }`,
      { q: title },
      7 * 24 * HOUR,
    );
    return data.Page.media;
  }

  async withRelations(id: number): Promise<AniMedia> {
    const data = await this.query<{ Media: AniMedia }>(
      `query ($id: Int) { Media(id: $id, type: ANIME) { ${FIELDS}
        relations { edges { relationType(version: 2) node { ${FIELDS} } } } } }`,
      { id },
      // A finished show with nothing announced rarely changes: recheck about weekly, spread
      // out so a large library doesn't expire all at once.
      ({ Media: m }) =>
        [m, ...(m.relations?.edges ?? []).map((e) => e.node)].some(
          (n) => n.status === 'RELEASING' || n.status === 'NOT_YET_RELEASED',
        )
          ? 12 * HOUR
          : (5 + Math.random() * 4) * 24 * HOUR,
    );
    return data.Media;
  }

  /** Popular anime by status (and optionally season), most popular first. */
  async list(opts: {
    status: 'RELEASING' | 'NOT_YET_RELEASED';
    season?: string;
    year?: number;
  }): Promise<AniMedia[]> {
    const data = await this.query<{ Page: { media: AniMedia[] } }>(
      `query ($status: MediaStatus, $season: MediaSeason, $year: Int) { Page(perPage: 30) {
        media(type: ANIME, status: $status, season: $season, seasonYear: $year, sort: POPULARITY_DESC, isAdult: false) { ${FIELDS} } } }`,
      { status: opts.status, season: opts.season, year: opts.year },
      6 * HOUR,
    );
    return data.Page.media;
  }
}

export function aniTitle(m: AniMedia): string {
  return m.title.english || m.title.romaji || m.title.native || `#${m.id}`;
}

export function aniDate(d: AniDate | null | undefined): string | undefined {
  if (!d?.year) return undefined;
  const mm = String(d.month ?? 1).padStart(2, '0');
  const dd = String(d.day ?? 1).padStart(2, '0');
  return `${d.year}-${mm}-${dd}`;
}

/** Strips AniList's HTML-ish markup from descriptions. */
export function aniPlain(desc: string | null | undefined): string | undefined {
  if (!desc) return undefined;
  return desc
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
