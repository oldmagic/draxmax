import { randomUUID } from 'node:crypto';
import type {
  ContentType,
  SiteDTO,
  SiteField,
  SiteInput,
  SiteMapping,
  SitePresetDTO,
  SiteTestHit,
  SiteTestResult,
} from '@draxmax/shared';
import { siteSchema } from '@draxmax/shared';
import type { Database } from '../db/database.ts';
import { CoreError } from '../errors.ts';
import type { CoreEvents } from '../events.ts';
import { fetchBytes } from '../net/http.ts';
import type { SearchResult, SearchSource } from '../missing/sources.ts';
import type { SecretCipher } from '../settings/settings.ts';
import { matchesText, RuleSyntaxError, validateRule } from '../rss/rules.ts';
import { parseSearch, type SiteHit } from './parse.ts';
import presetsFile from './presets.json' with { type: 'json' };
import { fill, placeholders, redactSecrets, TemplateError } from './templates.ts';

/** Fetches a search page: body text, content type and HTTP status. */
export type SiteFetch = (
  url: string,
  headers: Record<string, string>,
) => Promise<{ body: string; contentType: string; status: number }>;

export interface SiteServiceDeps {
  db: Database;
  cipher: SecretCipher | null;
  events: CoreEvents;
  /** Injected for tests. */
  fetch?: SiteFetch;
  /** Spacing between searches on one site (tests use 0). Private trackers dislike bursts. */
  intervalMs?: number;
}

interface Secrets {
  values: Record<string, string>;
  /** Normalised Cookie header ("a=b; c=d"). */
  cookies: string;
  headers: Record<string, string>;
}

interface SiteRow {
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
  secrets: Secrets;
  lastTest: SiteTestResult | null;
  createdAt: string;
  updatedAt: string;
}

const EMPTY: Secrets = { values: {}, cookies: '', headers: {} };
/** Headers users may not set (transport-level, or managed by us). */
const FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'cookie',
  'user-agent',
]);
const MAX_RESPONSE = 4 * 1024 * 1024;

/** "Cookie: a=b; c=d", "a=b\nc=d" → "a=b; c=d". Values are kept as given. */
export function normalizeCookies(input: string): string {
  return input
    .replace(/^\s*cookie\s*:/i, '')
    .split(/[;\n]/)
    .map((p) => p.trim())
    .filter((p) => /^[^=\s;]+=.*/.test(p))
    .join('; ');
}

/** "Name: value" lines → record (invalid or forbidden lines are rejected). */
export function parseHeaders(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of input
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)) {
    const m = /^([A-Za-z0-9-]{1,64})\s*:\s*(.*)$/.exec(line);
    if (!m) throw new CoreError('invalid_input', `Not a header line: "${line.slice(0, 40)}"`);
    if (FORBIDDEN_HEADERS.has(m[1]!.toLowerCase()))
      throw new CoreError('invalid_input', `The ${m[1]} header can't be set here`);
    if (/[\r\n]/.test(m[2]!))
      throw new CoreError('invalid_input', 'Header values must be one line');
    out[m[1]!] = m[2]!;
  }
  return out;
}

const hostOf = (u: string) => {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return '';
  }
};

type Raw = Record<string, unknown>;

/**
 * Tracker sites the user configures (credentials, search URLs, link patterns). They act as
 * search sources for missing episodes, and their cookies are sent to their own hosts when
 * RSS feeds or torrent links point there.
 */
export class SiteService {
  private readonly pacers = new Map<string, Promise<unknown>>();
  private readonly last = new Map<string, number>();

  constructor(private readonly deps: SiteServiceDeps) {}

  // --- Storage ---------------------------------------------------------------------

  private seal(s: Secrets): string {
    const json = JSON.stringify(s);
    return this.deps.cipher ? `enc:${this.deps.cipher.encrypt(json)}` : json;
  }

  private unseal(v: string): Secrets {
    if (!v) return { ...EMPTY, values: {}, headers: {} };
    try {
      const json = v.startsWith('enc:') ? (this.deps.cipher?.decrypt(v.slice(4)) ?? '') : v;
      const s = JSON.parse(json) as Partial<Secrets>;
      return { values: s.values ?? {}, cookies: s.cookies ?? '', headers: s.headers ?? {} };
    } catch {
      // Key file lost: the user re-enters credentials.
      return { values: {}, cookies: '', headers: {} };
    }
  }

  private fromRow(r: Raw): SiteRow {
    const j = <T>(v: unknown, d: T): T => {
      try {
        return v ? (JSON.parse(v as string) as T) : d;
      } catch {
        return d;
      }
    };
    return {
      id: r.id as string,
      name: r.name as string,
      preset: (r.preset as string | null) ?? null,
      enabled: r.enabled === 1,
      contentTypes: j<ContentType[]>(r.content_types, []),
      category: (r.category as string | null) ?? null,
      baseUrls: j<string[]>(r.base_urls, []),
      searchUrls: j<string[]>(r.search_urls, []),
      infoUrl: r.info_url as string,
      downloadUrl: r.download_url as string,
      mapping: j<SiteMapping>(r.mapping, { format: 'auto' }),
      mustMatch: j<string[]>(r.must_match, []),
      mustNotMatch: j<string[]>(r.must_not_match, []),
      fields: j<SiteField[]>(r.fields, []),
      secrets: this.unseal(r.secrets as string),
      lastTest: j<SiteTestResult | null>(r.last_test, null),
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  }

  private rows(): SiteRow[] {
    return (
      this.deps.db.prepare('SELECT * FROM sites ORDER BY name COLLATE NOCASE').all() as Raw[]
    ).map((r) => this.fromRow(r));
  }

  private row(id: string): SiteRow {
    const r = this.deps.db.prepare('SELECT * FROM sites WHERE id = ?').get(id) as Raw | undefined;
    if (!r) throw new CoreError('not_found', 'Site not found');
    return this.fromRow(r);
  }

  private save(s: SiteRow): void {
    this.deps.db
      .prepare(
        `INSERT INTO sites (id, name, preset, enabled, base_urls, search_urls, info_url, download_url, mapping, fields, secrets, last_test, created_at, updated_at, must_match, must_not_match, content_types, category)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, preset = excluded.preset, enabled = excluded.enabled,
           base_urls = excluded.base_urls, search_urls = excluded.search_urls, info_url = excluded.info_url,
           download_url = excluded.download_url, mapping = excluded.mapping, fields = excluded.fields,
           must_match = excluded.must_match, must_not_match = excluded.must_not_match,
           content_types = excluded.content_types, category = excluded.category,
           secrets = excluded.secrets, last_test = excluded.last_test, updated_at = excluded.updated_at`,
      )
      .run(
        s.id,
        s.name,
        s.preset,
        s.enabled ? 1 : 0,
        JSON.stringify(s.baseUrls),
        JSON.stringify(s.searchUrls),
        s.infoUrl,
        s.downloadUrl,
        JSON.stringify(s.mapping),
        JSON.stringify(s.fields),
        this.seal(s.secrets),
        s.lastTest ? JSON.stringify(s.lastTest) : null,
        s.createdAt,
        s.updatedAt,
        JSON.stringify(s.mustMatch),
        JSON.stringify(s.mustNotMatch),
        JSON.stringify(s.contentTypes),
        s.category,
      );
    this.deps.events.emit('sites:updated', null);
  }

  private toDTO(s: SiteRow): SiteDTO {
    return {
      id: s.id,
      name: s.name,
      preset: s.preset,
      enabled: s.enabled,
      contentTypes: s.contentTypes,
      category: s.category,
      baseUrls: s.baseUrls,
      searchUrls: s.searchUrls,
      infoUrl: s.infoUrl,
      downloadUrl: s.downloadUrl,
      mapping: s.mapping,
      mustMatch: s.mustMatch,
      mustNotMatch: s.mustNotMatch,
      fields: s.fields,
      secretsSet: {
        values: Object.fromEntries(Object.entries(s.secrets.values).map(([k, v]) => [k, v !== ''])),
        cookies: s.secrets.cookies ? s.secrets.cookies.split(';').length : 0,
        headers: Object.keys(s.secrets.headers).length,
      },
      lastTest: s.lastTest,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  // --- CRUD ------------------------------------------------------------------------

  list(): SiteDTO[] {
    return this.rows().map((s) => this.toDTO(s));
  }

  get(id: string): SiteDTO {
    return this.toDTO(this.row(id));
  }

  presets(): SitePresetDTO[] {
    return (presetsFile as { presets: SitePresetDTO[] }).presets;
  }

  /** Creates (no id) or updates a site. Secrets: omitted = keep, null = clear, value = set. */
  saveSite(input: SiteInput, id?: string): SiteDTO {
    const v = siteSchema.parse(input);
    const mustMatch = v.mustMatch.map((x) => x.trim()).filter(Boolean);
    const mustNotMatch = v.mustNotMatch.map((x) => x.trim()).filter(Boolean);
    for (const [label, list] of [
      ['Must match', mustMatch],
      ['Must not match', mustNotMatch],
    ] as const) {
      try {
        validateRule({ mustContain: list, mustNotContain: [], useRegex: true });
      } catch (err) {
        if (err instanceof RuleSyntaxError)
          throw new CoreError('invalid_input', `${label}: ${err.message}`);
        throw err;
      }
    }
    const prev = id ? this.row(id) : null;
    const hosts = new Set(v.baseUrls.map(hostOf));
    // Templates may only point at the site's own hosts, so credentials can't leak elsewhere.
    for (const t of [...v.searchUrls, v.infoUrl, v.downloadUrl].filter(Boolean)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(t)) {
        const h = hostOf(t.replace(/\{[^}]+\}/g, 'x'));
        if (!/^https?:/i.test(t) || !hosts.has(h))
          throw new CoreError('invalid_input', `${t.slice(0, 60)} is not on this site's URLs`);
      }
    }
    const secrets: Secrets = prev
      ? {
          values: { ...prev.secrets.values },
          cookies: prev.secrets.cookies,
          headers: { ...prev.secrets.headers },
        }
      : { values: {}, cookies: '', headers: {} };
    for (const [k, val] of Object.entries(v.values ?? {})) secrets.values[k] = val?.trim() ?? '';
    secrets.values = Object.fromEntries(Object.entries(secrets.values).filter(([, x]) => x));
    if (v.cookies !== undefined) secrets.cookies = v.cookies ? normalizeCookies(v.cookies) : '';
    if (v.headers !== undefined) secrets.headers = v.headers ? parseHeaders(v.headers) : {};
    const now = new Date().toISOString();
    const row: SiteRow = {
      id: prev?.id ?? randomUUID(),
      name: v.name,
      preset: v.preset,
      enabled: v.enabled,
      contentTypes: [...new Set(v.contentTypes)],
      category: v.category || null,
      baseUrls: v.baseUrls,
      searchUrls: v.searchUrls,
      infoUrl: v.infoUrl,
      downloadUrl: v.downloadUrl,
      mapping: v.mapping,
      mustMatch,
      mustNotMatch,
      fields: v.fields,
      secrets,
      lastTest: prev?.lastTest ?? null,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    this.save(row);
    return this.toDTO(row);
  }

  setEnabled(id: string, enabled: boolean): SiteDTO {
    const row = this.row(id);
    row.enabled = enabled;
    row.updatedAt = new Date().toISOString();
    this.save(row);
    return this.toDTO(row);
  }

  delete(id: string): void {
    this.deps.db.prepare('DELETE FROM sites WHERE id = ?').run(id);
    this.deps.events.emit('sites:updated', null);
  }

  // --- Requests ----------------------------------------------------------------------

  /** Cookies and headers for a URL on one of the enabled sites' hosts (else none). */
  headersFor(url: string): Record<string, string> {
    const h = hostOf(url);
    if (!h) return {};
    const site = this.rows().find((s) => s.enabled && s.baseUrls.some((b) => hostOf(b) === h));
    return site ? this.requestHeaders(site) : {};
  }

  /** Whether a URL is on a configured site (its torrent links may be on the local network). */
  ownsUrl(url: string): boolean {
    const h = hostOf(url);
    return !!h && this.rows().some((s) => s.enabled && s.baseUrls.some((b) => hostOf(b) === h));
  }

  private requestHeaders(s: SiteRow): Record<string, string> {
    return {
      ...s.secrets.headers,
      ...(s.secrets.cookies ? { cookie: s.secrets.cookies } : {}),
    };
  }

  private secretValues(s: SiteRow): string[] {
    return [
      ...Object.values(s.secrets.values),
      ...s.secrets.cookies.split(';').map((c) => c.split('=').slice(1).join('=').trim()),
      ...Object.values(s.secrets.headers).map((v) => v.replace(/^(Bearer|Basic|Token)\s+/i, '')),
    ];
  }

  private async fetchPage(url: string, headers: Record<string, string>) {
    if (this.deps.fetch) return this.deps.fetch(url, headers);
    const res = await fetchBytes(url, {
      headers: {
        accept: 'application/json, application/rss+xml, text/html;q=0.9, */*;q=0.5',
        ...headers,
      },
      maxBytes: MAX_RESPONSE,
      timeoutMs: 30_000,
      acceptErrors: true,
    });
    return {
      body: Buffer.from(res.body).toString('utf8'),
      contentType: res.contentType,
      status: res.status,
    };
  }

  /** Serialises and spaces requests per site. */
  private paced<T>(siteId: string, fn: () => Promise<T>): Promise<T> {
    const gap = this.deps.intervalMs ?? 4_000;
    const prev = this.pacers.get(siteId) ?? Promise.resolve();
    const run = prev.then(async () => {
      const wait = (this.last.get(siteId) ?? 0) + gap - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last.set(siteId, Date.now());
      return fn();
    });
    this.pacers.set(
      siteId,
      run.catch(() => undefined),
    );
    return run;
  }

  /** Release filters: any "must match" line (none = all) and no "must not match" line. */
  private passes(s: SiteRow, title: string): SiteTestHit['filtered'] {
    if (
      s.mustNotMatch.length &&
      !matchesText({ mustContain: [], mustNotContain: s.mustNotMatch, useRegex: true }, title)
    )
      return 'excluded';
    if (
      s.mustMatch.length &&
      !matchesText({ mustContain: s.mustMatch, mustNotContain: [], useRegex: true }, title)
    )
      return 'not-matched';
    return 'ok';
  }

  /** Download link for a hit: the response's own link, or the site's template. */
  private downloadLink(s: SiteRow, hit: SiteHit): string | null {
    const base = s.baseUrls[0]!;
    if (hit.link) return new URL(hit.link, base).toString();
    if (!s.downloadUrl || !hit.id) return null;
    return new URL(
      fill(s.downloadUrl, {
        ...s.secrets.values,
        id: hit.id,
        releaseName: hit.title,
        title: hit.title,
        ...(hit.groupId ? { groupId: hit.groupId } : {}),
      }),
      base,
    ).toString();
  }

  /** Runs one search template; returns parsed hits plus what's needed to explain failures. */
  private async searchOnce(s: SiteRow, template: string, query: string) {
    const url = new URL(fill(template, { ...s.secrets.values, query }), s.baseUrls[0]).toString();
    if (!s.baseUrls.some((b) => hostOf(b) === hostOf(url)))
      throw new CoreError('invalid_input', 'Search URL is not on this site');
    const res = await this.paced(s.id, () => this.fetchPage(url, this.requestHeaders(s)));
    if (res.status >= 400) return { url, res, parsed: null, error: `HTTP ${res.status}` };
    if (/<input[^>]+type\s*=\s*["']?password/i.test(res.body) && !/json/i.test(res.contentType))
      return { url, res, parsed: null, error: 'Got a login page: check the session cookies' };
    try {
      const parsed = await parseSearch(res.body, res.contentType, {
        infoUrl: s.infoUrl,
        mapping: s.mapping,
      });
      return { url, res, parsed, error: null };
    } catch (err) {
      return { url, res, parsed: null, error: (err as Error).message };
    }
  }

  /** "Test search" from the UI: tries each search URL until one gives results. */
  async test(id: string, query: string): Promise<SiteTestResult> {
    const s = this.row(id);
    const secrets = this.secretValues(s);
    const mask = (t: string) => redactSecrets(t, secrets);
    let result: SiteTestResult | null = null;
    if (!s.searchUrls.length)
      result = this.testResult({
        ok: false,
        url: '',
        error: 'Add a search URL with {query} first',
      });
    for (const template of s.searchUrls) {
      try {
        const missing = placeholders(template).filter((n) => n !== 'query' && !s.secrets.values[n]);
        if (missing.length) throw new TemplateError(`No value for {${missing.join('}, {')}}`);
        const { url, res, parsed, error } = await this.searchOnce(s, template, query);
        const hits: SiteTestHit[] = [];
        let linkError: string | null = null;
        for (const h of parsed?.hits ?? []) {
          let link: string | null = null;
          try {
            link = this.downloadLink(s, h);
          } catch (err) {
            linkError ??= `Download link: ${(err as Error).message}`;
          }
          hits.push({
            title: h.title,
            id: h.id,
            seeders: h.seeders,
            size: h.size,
            downloadUrl: link && mask(link),
            filtered: this.passes(s, h.title),
          });
        }
        const ok = !error && hits.length > 0;
        const blocked = hits.filter((h) => h.filtered !== 'ok').length;
        const filterNote = blocked
          ? `${hits.length - blocked} of ${hits.length} results pass this site's release filters`
          : null;
        result = this.testResult({
          ok,
          url: mask(url),
          status: res.status,
          format: parsed?.format ?? null,
          mapping: parsed?.mapping ?? null,
          results: hits.slice(0, 25),
          total: hits.length,
          error:
            error ?? (hits.length ? (linkError ?? filterNote) : 'No results found in the response'),
          excerpt: ok ? null : mask(res.body.slice(0, 1500)),
        });
        if (ok) break;
      } catch (err) {
        result = this.testResult({ ok: false, url: mask(template), error: (err as Error).message });
      }
    }
    s.lastTest = result;
    s.updatedAt = new Date().toISOString();
    this.save(s);
    return result!;
  }

  private testResult(p: Partial<SiteTestResult> & { ok: boolean; url: string }): SiteTestResult {
    return {
      status: null,
      format: null,
      mapping: null,
      results: [],
      total: 0,
      error: null,
      excerpt: null,
      at: new Date().toISOString(),
      ...p,
    };
  }

  /** One search source per enabled site with a search URL (for missing episodes). */
  sources(): SearchSource[] {
    return this.rows()
      .filter((s) => s.enabled && s.searchUrls.length > 0)
      .map((s) => ({
        name: `Site: ${s.name}`,
        animeOnly: false,
        types: s.contentTypes,
        search: async (query: string): Promise<SearchResult[]> => {
          let lastError: string | null = null;
          for (const template of s.searchUrls) {
            let r;
            try {
              r = await this.searchOnce(s, template, query);
            } catch (err) {
              lastError = (err as Error).message;
              continue;
            }
            if (r.error || !r.parsed) {
              lastError = r.error;
              continue;
            }
            const out = r.parsed.hits.flatMap((h): SearchResult[] => {
              // The site's release filters decide what it may download at all.
              if (this.passes(s, h.title) !== 'ok') return [];
              try {
                const url = this.downloadLink(s, h);
                return url
                  ? [
                      {
                        title: h.title,
                        url,
                        seeders: h.seeders,
                        size: h.size,
                        source: `Site: ${s.name}`,
                        ...(s.category ? { category: s.category } : {}),
                      },
                    ]
                  : [];
              } catch {
                return [];
              }
            });
            if (out.length) return out;
          }
          if (lastError) throw new Error(lastError);
          return [];
        },
      }));
  }
}
