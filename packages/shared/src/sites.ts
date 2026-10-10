import { z } from 'zod';

const httpUrl = z.url({ protocol: /^https?$/ }).max(2048);
const template = z.string().trim().max(2048);
const fieldName = z.string().regex(/^[A-Za-z0-9_]{1,64}$/, 'Letters, digits and _ only');

/** What a site carries. A site without any is searched for everything. */
export const CONTENT_TYPES = ['anime', 'tv', 'movies'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

/** How search responses are read; omitted fields are auto-detected. */
export const siteMappingSchema = z.object({
  format: z.enum(['auto', 'json', 'html', 'rss']).default('auto'),
  /** JSON dot paths ("data.torrents", "name", …). */
  list: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
  id: z.string().max(200).optional(),
  groupId: z.string().max(200).optional(),
  seeders: z.string().max(200).optional(),
  size: z.string().max(200).optional(),
  download: z.string().max(200).optional(),
});
export type SiteMapping = z.input<typeof siteMappingSchema>;

export const siteFieldSchema = z.object({
  name: fieldName,
  label: z.string().trim().min(1).max(100),
  help: z.string().max(300).optional(),
});
export type SiteField = z.infer<typeof siteFieldSchema>;

/**
 * Create/update body. Secrets follow the settings rule: omitted = keep, null = clear,
 * string = replace. `cookies` is "name=value; name2=value2" (one Cookie header, or one
 * pair per line); `headers` is one "Name: value" per line.
 */
export const siteSchema = z.object({
  name: z.string().trim().min(1).max(100),
  preset: z.string().max(100).nullable().default(null),
  enabled: z.boolean().default(true),
  /** Kinds of content this site is searched for; empty = everything. */
  contentTypes: z.array(z.enum(CONTENT_TYPES)).max(3).default([]),
  /** Download category for torrents found here, when the rule or request doesn't set one. */
  category: z.string().trim().max(100).nullable().default(null),
  baseUrls: z.array(httpUrl).min(1).max(20),
  searchUrls: z.array(template.min(1)).max(10).default([]),
  infoUrl: template.default(''),
  downloadUrl: template.default(''),
  mapping: siteMappingSchema.default({ format: 'auto' }),
  /** Release filters (case-insensitive regexes): any "must match" line, no "must not match" line. */
  mustMatch: z.array(z.string().max(500)).max(50).default([]),
  mustNotMatch: z.array(z.string().max(500)).max(50).default([]),
  fields: z.array(siteFieldSchema).max(20).default([]),
  values: z.record(fieldName, z.string().max(4096).nullable()).optional(),
  cookies: z.string().max(16_384).nullable().optional(),
  headers: z.string().max(16_384).nullable().optional(),
});
export type SiteInput = z.input<typeof siteSchema>;

export interface SiteTestHit {
  title: string;
  id: string | null;
  seeders: number | null;
  size: number | null;
  /** Download link with secrets masked. */
  downloadUrl: string | null;
  /** What the site's release filters say: kept, not matched by "must match", or excluded. */
  filtered: 'ok' | 'not-matched' | 'excluded';
}

export interface SiteTestResult {
  ok: boolean;
  /** Search URL that was tried (secrets masked). */
  url: string;
  status: number | null;
  format: 'json' | 'html' | 'rss' | null;
  /** Mapping that was used, to save with "Use these mappings". */
  mapping: SiteMapping | null;
  results: SiteTestHit[];
  total: number;
  error: string | null;
  /** Start of the response (secrets masked), when nothing could be read. */
  excerpt: string | null;
  at: string;
}

export interface SiteDTO {
  id: string;
  name: string;
  preset: string | null;
  enabled: boolean;
  contentTypes: ContentType[];
  category: string | null;
  baseUrls: string[];
  searchUrls: string[];
  infoUrl: string;
  downloadUrl: string;
  mapping: SiteMapping;
  mustMatch: string[];
  mustNotMatch: string[];
  fields: SiteField[];
  /** Which secrets are stored (values are never sent back). */
  secretsSet: { values: Record<string, boolean>; cookies: number; headers: number };
  lastTest: SiteTestResult | null;
  createdAt: string;
  updatedAt: string;
}

export interface SitePresetDTO {
  id: string;
  name: string;
  privacy: string;
  urls: string[];
  fields: (SiteField & { secret: boolean })[];
  infoUrl: string;
  downloadUrl: string;
  searchUrls: string[];
}

export const siteTestSchema = z.object({ query: z.string().trim().min(1).max(200) });
