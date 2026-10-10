import { randomUUID } from 'node:crypto';
import type {
  ContentType,
  SearchResponse,
  SearchResultDTO,
  SearchSourceDTO,
  TorrentItem,
} from '@draxmax/shared';
import { CoreError } from '../errors.ts';
import { parseRelease } from '../media/parse-title.ts';
import type { MissingService } from '../missing/missing-service.ts';
import {
  parseTorznabUrls,
  sourceCarries,
  torznabLabel,
  type SearchResult,
} from '../missing/sources.ts';
import type { SettingsStore } from '../settings/settings.ts';
import type { SiteService } from '../sites/site-service.ts';
import type { AddOptions, TorrentManager } from '../torrent/manager.ts';
import { parseMagnet } from '../torrent/sources.ts';

/** How long a result's handle can still be added after its search. */
const RESULT_TTL_MS = 60 * 60_000;
const MAX_CACHED = 5000;
const MAX_RESULTS = 300;

export interface SearchDeps {
  missing: Pick<MissingService, 'sources' | 'addResult'>;
  sites: Pick<SiteService, 'list'>;
  torrents: Pick<TorrentManager, 'hasInfoHash'>;
  settings: SettingsStore;
}

/**
 * Search from the UI, over the same sources the missing-episode check uses, plus managing
 * the non-site sources (built-in indexers and Torznab endpoints). Results are handed out as
 * opaque handles: their download links can carry passkeys and never leave the server.
 */
export class SearchService {
  private readonly cache = new Map<string, { result: SearchResult; at: number }>();

  constructor(private readonly deps: SearchDeps) {}

  async search(query: string, type: ContentType | null = null): Promise<SearchResponse> {
    const sources = this.deps.missing.sources().filter((s) => sourceCarries(s, type));
    const errors: SearchResponse['errors'] = [];
    const found = (
      await Promise.all(
        sources.map((s) =>
          s.search(query).catch((err: Error) => {
            errors.push({ source: s.name, error: err.message });
            return [] as SearchResult[];
          }),
        ),
      )
    ).flat();
    // Best seeded first; unknown seeder counts after known ones.
    found.sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1));
    this.prune();
    const seen = new Set<string>();
    const results: SearchResultDTO[] = [];
    for (const result of found) {
      if (results.length >= MAX_RESULTS) break;
      const key = `${result.source}|${result.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const id = randomUUID();
      this.cache.set(id, { result, at: Date.now() });
      const r = parseRelease(result.title);
      let inList = false;
      try {
        if (result.url.startsWith('magnet:'))
          inList = this.deps.torrents.hasInfoHash(parseMagnet(result.url).infoHash);
      } catch {
        // Not a v1 magnet: can't tell.
      }
      results.push({
        id,
        title: result.title,
        source: result.source,
        seeders: result.seeders,
        size: result.size,
        show: r.title,
        season: r.season ?? null,
        episodes: r.episodes,
        inList,
      });
    }
    return { query, results, searched: sources.map((s) => s.name), errors };
  }

  /** Adds a result from a recent search to the download list. */
  async add(id: string, opts: AddOptions): Promise<TorrentItem> {
    const hit = this.cache.get(id);
    if (!hit || Date.now() - hit.at > RESULT_TTL_MS)
      throw new CoreError('not_found', 'This result has expired. Search again.');
    return this.deps.missing.addResult(hit.result, {
      origin: 'manual',
      originDetail: hit.result.source,
      ...opts,
      category: opts.category ?? hit.result.category,
    });
  }

  private prune(): void {
    const cutoff = Date.now() - RESULT_TTL_MS;
    for (const [id, v] of this.cache) {
      if (v.at >= cutoff && this.cache.size <= MAX_CACHED) break;
      this.cache.delete(id);
    }
  }

  // --- Sources ---------------------------------------------------------------------

  /** Everything searches can go to, enabled or not. */
  sourceList(): SearchSourceDTO[] {
    const s = this.deps.settings.get();
    const locked = new Set<string>(this.deps.settings.lockedKeys());
    return [
      {
        id: 'nyaa',
        kind: 'builtin',
        name: 'Nyaa',
        enabled: s.missingUseNyaa,
        contentTypes: ['anime'],
        detail: 'nyaa.si',
        locked: locked.has('missingUseNyaa'),
      },
      {
        id: 'animetosho',
        kind: 'builtin',
        name: 'AnimeTosho',
        enabled: s.missingUseAnimeTosho,
        contentTypes: ['anime'],
        detail: 'animetosho.org',
        locked: locked.has('missingUseAnimeTosho'),
      },
      ...parseTorznabUrls(s.torznabUrls).map((u, i): SearchSourceDTO => ({
        id: `torznab:${i}`,
        kind: 'torznab',
        name: `Torznab: ${torznabLabel(u)}`,
        enabled: true,
        contentTypes: [],
        detail: torznabLabel(u),
        locked: locked.has('torznabUrls'),
      })),
      ...this.deps.sites.list().map((site): SearchSourceDTO => ({
        id: `site:${site.id}`,
        kind: 'site',
        name: site.name,
        enabled: site.enabled && site.searchUrls.length > 0,
        contentTypes: site.contentTypes,
        detail: site.searchUrls.length ? null : 'No search URL yet',
        locked: false,
      })),
    ];
  }

  setBuiltinEnabled(id: string, enabled: boolean): void {
    const key =
      id === 'nyaa' ? 'missingUseNyaa' : id === 'animetosho' ? 'missingUseAnimeTosho' : null;
    if (!key) throw new CoreError('not_found', 'Unknown source');
    this.unlocked(key);
    this.deps.settings.update({ [key]: enabled });
  }

  addTorznab(url: string): void {
    this.unlocked('torznabUrls');
    const urls = parseTorznabUrls(this.deps.settings.get().torznabUrls);
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      throw new CoreError('invalid_input', 'Not a valid URL');
    }
    if (!/^https?:$/.test(parsed.protocol))
      throw new CoreError('invalid_input', 'Use an http(s) URL');
    if (urls.includes(parsed.toString()))
      throw new CoreError('conflict', 'This indexer is already added');
    this.deps.settings.update({ torznabUrls: [...urls, parsed.toString()].join('\n') });
  }

  removeTorznab(index: number): void {
    this.unlocked('torznabUrls');
    const urls = parseTorznabUrls(this.deps.settings.get().torznabUrls);
    if (!urls[index]) throw new CoreError('not_found', 'Indexer not found');
    urls.splice(index, 1);
    this.deps.settings.update({ torznabUrls: urls.join('\n') });
  }

  /** Runs one search on a built-in or Torznab source and reports what came back. */
  async testSource(
    id: string,
    query: string,
  ): Promise<{ ok: boolean; total: number; sample: string[]; error: string | null }> {
    const dto = this.sourceList().find((x) => x.id === id);
    if (!dto || dto.kind === 'site') throw new CoreError('not_found', 'Unknown source');
    const source = this.deps.missing.sources().find((x) => x.name === dto.name);
    if (!source) return { ok: false, total: 0, sample: [], error: 'This source is turned off' };
    try {
      const results = await source.search(query);
      return {
        ok: results.length > 0,
        total: results.length,
        sample: results.slice(0, 5).map((r) => r.title),
        error: results.length ? null : 'The search worked but found nothing',
      };
    } catch (err) {
      return { ok: false, total: 0, sample: [], error: (err as Error).message };
    }
  }

  private unlocked(key: string): void {
    if ((this.deps.settings.lockedKeys() as string[]).includes(key))
      throw new CoreError('invalid_input', 'This is set by an environment variable');
  }
}
