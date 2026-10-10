import { z } from 'zod';
import { CONTENT_TYPES, type ContentType } from './sites.ts';

/** One release found by a search. The download link stays on the server (it may hold a passkey). */
export interface SearchResultDTO {
  /** Handle for POST /api/search/add; valid for a while after the search. */
  id: string;
  title: string;
  source: string;
  seeders: number | null;
  size: number | null;
  /** What the release name says it is. */
  show: string;
  season: number | null;
  episodes: number[];
  /** Already in the download list. */
  inList: boolean;
}

export interface SearchResponse {
  query: string;
  results: SearchResultDTO[];
  /** Sources that were asked, and the ones that failed. */
  searched: string[];
  errors: { source: string; error: string }[];
}

/** A place searches go to: built-in indexers, Torznab endpoints and configured sites. */
export interface SearchSourceDTO {
  id: string;
  kind: 'builtin' | 'torznab' | 'site';
  name: string;
  enabled: boolean;
  /** Empty = everything. */
  contentTypes: ContentType[];
  /** Torznab: the endpoint with its API key masked. */
  detail: string | null;
  /** Set by an environment variable; can't be changed here. */
  locked: boolean;
}

export const searchQuerySchema = z.object({
  q: z.string().trim().min(2).max(200),
  type: z.enum(CONTENT_TYPES).optional(),
});

export const searchAddSchema = z.object({
  id: z.string().min(1).max(100),
  category: z.string().trim().max(100).optional(),
  savePath: z.string().trim().max(4096).optional(),
  paused: z.boolean().optional(),
});

export const torznabAddSchema = z.object({
  url: z.url({ protocol: /^https?$/ }).max(2048),
});

export const sourceTestSchema = z.object({ query: z.string().trim().min(1).max(200) });
