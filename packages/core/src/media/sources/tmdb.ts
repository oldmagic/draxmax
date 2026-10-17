import { fetchJson, HttpError } from '../../net/http.ts';
import type { HttpCache } from '../http-cache.ts';

const API = 'https://api.themoviedb.org/3';
export const TMDB_IMAGE = 'https://image.tmdb.org/t/p/w342';
const HOUR = 3600_000;

export interface TmdbSearchResult {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  popularity?: number;
}

export interface TmdbEpisode {
  air_date?: string | null;
  episode_number: number;
  season_number: number;
  name?: string;
}

export interface TmdbTvDetails {
  id: number;
  name: string;
  overview?: string;
  poster_path?: string | null;
  status?: string;
  popularity?: number;
  number_of_seasons?: number;
  next_episode_to_air?: TmdbEpisode | null;
  last_episode_to_air?: TmdbEpisode | null;
  seasons?: {
    season_number: number;
    air_date?: string | null;
    poster_path?: string | null;
    overview?: string;
    episode_count?: number;
    name?: string;
  }[];
}

export interface TmdbMovie {
  id: number;
  title: string;
  overview?: string;
  poster_path?: string | null;
  release_date?: string;
  popularity?: number;
  belongs_to_collection?: { id: number; name: string } | null;
}

export interface TmdbCollection {
  id: number;
  name: string;
  parts: TmdbMovie[];
}

export interface TmdbListItem {
  id: number;
  title?: string;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  popularity?: number;
  original_language?: string;
  genre_ids?: number[];
}

/**
 * Minimal TMDB v3 client. Accepts either a v3 API key or a v4 read access token
 * (JWT, sent as Bearer). Responses are cached in SQLite.
 */
export class TmdbClient {
  constructor(
    private readonly key: string,
    private readonly cache: HttpCache,
  ) {}

  private async get<T>(
    path: string,
    params: Record<string, string | number | undefined>,
    ttlMs: number,
  ): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params))
      if (v !== undefined && v !== '') qs.set(k, String(v));
    const bearer = this.key.startsWith('eyJ');
    if (!bearer) qs.set('api_key', this.key);
    const url = `${API}${path}?${qs}`;
    const cacheKey = `tmdb:${path}?${new URLSearchParams([...qs].filter(([k]) => k !== 'api_key'))}`;
    return this.cache.wrap(cacheKey, ttlMs, async () => {
      try {
        return await fetchJson<T>(url, {
          headers: bearer ? { authorization: `Bearer ${this.key}` } : {},
          timeoutMs: 15_000,
        });
      } catch (err) {
        if (err instanceof HttpError && err.status === 401)
          throw new Error('TMDB rejected the API key', { cause: err });
        throw err;
      }
    });
  }

  async searchTv(query: string, year?: number): Promise<TmdbSearchResult[]> {
    const r = await this.get<{ results: TmdbSearchResult[] }>(
      '/search/tv',
      { query, first_air_date_year: year, include_adult: 'false' },
      7 * 24 * HOUR,
    );
    return r.results ?? [];
  }

  async searchMovie(query: string, year?: number): Promise<TmdbSearchResult[]> {
    const r = await this.get<{ results: TmdbSearchResult[] }>(
      '/search/movie',
      { query, year, include_adult: 'false' },
      7 * 24 * HOUR,
    );
    return r.results ?? [];
  }

  tv(id: number): Promise<TmdbTvDetails> {
    return this.get(`/tv/${id}`, {}, 12 * HOUR);
  }

  movie(id: number): Promise<TmdbMovie> {
    return this.get(`/movie/${id}`, {}, 3 * 24 * HOUR);
  }

  collection(id: number): Promise<TmdbCollection> {
    return this.get(`/collection/${id}`, {}, 3 * 24 * HOUR);
  }

  /** Most popular movies or new shows whose (first) release falls between two dates. */
  async discover(
    type: 'movie' | 'tv',
    from: string,
    to: string,
    page = 1,
  ): Promise<TmdbListItem[]> {
    const field = type === 'movie' ? 'primary_release_date' : 'first_air_date';
    const r = await this.get<{ results: TmdbListItem[] }>(
      `/discover/${type}`,
      {
        [`${field}.gte`]: from,
        [`${field}.lte`]: to,
        sort_by: 'popularity.desc',
        include_adult: 'false',
        page,
      },
      6 * HOUR,
    );
    return r.results ?? [];
  }

  async list(
    path: '/movie/upcoming' | '/movie/now_playing' | '/tv/on_the_air' | '/tv/airing_today',
    page = 1,
  ): Promise<TmdbListItem[]> {
    const r = await this.get<{ results: TmdbListItem[] }>(path, { page }, 6 * HOUR);
    return r.results ?? [];
  }
}
