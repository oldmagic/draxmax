import { randomUUID } from 'node:crypto';
import {
  BUILTIN_INDEXERS,
  BUILTIN_XDCC_INDEXERS,
  type BuiltinIndexerId,
  type XdccIndexerId,
  type XdccTransferDTO,
  type ContentType,
  type SearchResponse,
  type SearchResultDTO,
  type SearchSourceDTO,
  type SourceEdit,
  type TorrentItem,
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
import type { Settings, SettingsStore } from '../settings/settings.ts';
import type { SiteService } from '../sites/site-service.ts';
import type { AddOptions, TorrentManager } from '../torrent/manager.ts';
import { parseMagnet } from '../torrent/sources.ts';
import {
  xdccInfoIndexer,
  type FetchJson,
  type XdccIndexer,
  type XdccPack,
} from '../xdcc/xdcc-info.ts';
import type { XdccService } from '../xdcc/xdcc-service.ts';

/** How long a result's handle can still be added after its search. */
const RESULT_TTL_MS = 60 * 60_000;
const MAX_CACHED = 5000;
const MAX_RESULTS = 300;
/** XDCC results come after the torrents, up to this many. */
const MAX_XDCC_RESULTS = 150;

function isXdccIndexer(id: string): id is XdccIndexerId {
  return BUILTIN_XDCC_INDEXERS.some((b) => b.id === id);
}

type Cached = { kind: 'torrent'; result: SearchResult } | { kind: 'xdcc'; pack: XdccPack };

/** The setting that turns each built-in indexer on. */
const ENABLED_KEY = {
  nyaa: 'missingUseNyaa',
  animetosho: 'missingUseAnimeTosho',
  subsplease: 'missingUseSubsPlease',
} as const satisfies Record<BuiltinIndexerId, keyof Settings>;

function isBuiltin(id: string): id is BuiltinIndexerId {
  return Object.hasOwn(ENABLED_KEY, id);
}

function httpUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new CoreError('invalid_input', 'Not a valid URL');
  }
  if (!/^https?:$/.test(parsed.protocol))
    throw new CoreError('invalid_input', 'Use an http(s) URL');
  return parsed.toString();
}

/** A site's address without a trailing slash, e.g. `https://nyaa.land`. */
function siteAddress(raw: string): string {
  const u = new URL(
    httpUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw : `https://${raw.trim()}`),
  );
  if (u.search || u.hash || u.username || u.password)
    throw new CoreError('invalid_input', 'Enter just the address, e.g. https://nyaa.si');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

export interface SearchDeps {
  missing: Pick<MissingService, 'sources' | 'addResult'>;
  sites: Pick<SiteService, 'list'>;
  torrents: Pick<TorrentManager, 'hasInfoHash'>;
  settings: SettingsStore;
  xdcc?: Pick<XdccService, 'add' | 'list'>;
  /** Network override for XDCC indexers (tests). */
  xdccFetch?: FetchJson;
}

/**
 * Search from the UI, over the same sources the missing-episode check uses, plus managing
 * the non-site sources (built-in indexers and Torznab endpoints). Results are handed out as
 * opaque handles: their download links can carry passkeys and never leave the server.
 */
export class SearchService {
  private readonly cache = new Map<string, Cached & { at: number }>();
  /** Indexer instances keep a little state (xdcc.info's network list); reuse them. */
  private xdccIndexerCache = new Map<string, XdccIndexer>();

  constructor(private readonly deps: SearchDeps) {}

  /** The enabled XDCC indexers. */
  xdccIndexers(): XdccIndexer[] {
    if (!this.deps.xdcc) return [];
    const edits = this.deps.settings.get().xdccIndexers;
    const out: XdccIndexer[] = [];
    for (const b of BUILTIN_XDCC_INDEXERS) {
      if (edits[b.id]?.enabled === false) continue;
      const url = edits[b.id]?.url ?? b.url;
      let ix = this.xdccIndexerCache.get(url);
      if (!ix) {
        ix = xdccInfoIndexer(url, this.deps.xdccFetch);
        this.xdccIndexerCache.set(url, ix);
      }
      out.push(ix);
    }
    return out;
  }

  async search(query: string, type: ContentType | null = null): Promise<SearchResponse> {
    const sources = this.deps.missing.sources().filter((s) => sourceCarries(s, type));
    const xdccSources = this.xdccIndexers();
    const errors: SearchResponse['errors'] = [];
    const [found, packs] = await Promise.all([
      Promise.all(
        sources.map((s) =>
          s.search(query).catch((err: Error) => {
            errors.push({ source: s.name, error: err.message });
            return [] as SearchResult[];
          }),
        ),
      ).then((r) => r.flat()),
      Promise.all(
        xdccSources.map((s) =>
          s.search(query).catch((err: Error) => {
            errors.push({ source: s.name, error: err.message });
            return [] as XdccPack[];
          }),
        ),
      ).then((r) => r.flat()),
    ]);
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
      this.cache.set(id, { kind: 'torrent', result, at: Date.now() });
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
        kind: 'torrent',
      });
    }
    // Packs already in the XDCC list (any state but failed/cancelled).
    const queued = new Set(
      (this.deps.xdcc?.list() ?? [])
        .filter((t) => t.status !== 'error' && t.status !== 'cancelled')
        .map((t) => `${t.server.split(':')[0]}|${t.bot.toLowerCase()}|${t.pack}`),
    );
    // Most downloaded first: busy packs are the ones bots still serve.
    packs.sort((a, b) => (b.gets ?? -1) - (a.gets ?? -1));
    let xdccCount = 0;
    for (const pack of packs) {
      if (xdccCount >= MAX_XDCC_RESULTS) break;
      const key = `xdcc|${pack.host}|${pack.bot}|${pack.pack}`;
      if (seen.has(key)) continue;
      seen.add(key);
      xdccCount++;
      const id = randomUUID();
      this.cache.set(id, { kind: 'xdcc', pack, at: Date.now() });
      const r = parseRelease(pack.filename);
      results.push({
        id,
        title: pack.filename,
        source: pack.source,
        seeders: null,
        size: pack.size,
        show: r.title,
        season: r.season ?? null,
        episodes: r.episodes,
        inList: queued.has(`${pack.host}|${pack.bot.toLowerCase()}|${pack.pack}`),
        kind: 'xdcc',
        xdcc: {
          network: pack.network,
          bot: pack.bot,
          channel: pack.channel,
          pack: pack.pack,
          gets: pack.gets,
          lastSeen: pack.lastSeen,
        },
      });
    }
    return {
      query,
      results,
      searched: [...sources.map((s) => s.name), ...xdccSources.map((s) => s.name)],
      errors,
    };
  }

  private cached(id: string): Cached {
    const hit = this.cache.get(id);
    if (!hit || Date.now() - hit.at > RESULT_TTL_MS)
      throw new CoreError('not_found', 'This result has expired. Search again.');
    return hit;
  }

  /** Adds a result from a recent search to the download list. */
  async add(id: string, opts: AddOptions): Promise<TorrentItem> {
    const hit = this.cached(id);
    if (hit.kind !== 'torrent')
      throw new CoreError('invalid_input', 'This is an XDCC result: add it with POST /api/xdcc');
    return this.deps.missing.addResult(hit.result, {
      origin: 'manual',
      originDetail: hit.result.source,
      ...opts,
      category: opts.category ?? hit.result.category,
    });
  }

  /** Starts an XDCC transfer for a result from a recent search. */
  addXdcc(id: string, opts: { savePath?: string } = {}): XdccTransferDTO {
    const hit = this.cached(id);
    if (hit.kind !== 'xdcc' || !this.deps.xdcc)
      throw new CoreError('invalid_input', 'This result is a torrent, not an XDCC pack');
    return this.deps.xdcc.add(hit.pack, opts);
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
      ...BUILTIN_INDEXERS.map((b): SearchSourceDTO => {
        const edit = s.builtinIndexers[b.id];
        const url = edit?.url ?? b.url;
        return {
          id: b.id,
          kind: 'builtin',
          name: b.name,
          enabled: s[ENABLED_KEY[b.id]],
          contentTypes: edit?.contentTypes ?? ['anime'],
          detail: new URL(url).host,
          url,
          defaultUrl: b.url,
          locked: locked.has(ENABLED_KEY[b.id]),
        };
      }),
      ...parseTorznabUrls(s.torznabUrls).map((u, i): SearchSourceDTO => ({
        id: `torznab:${i}`,
        kind: 'torznab',
        name: `Torznab: ${torznabLabel(u)}`,
        enabled: true,
        contentTypes: [],
        detail: torznabLabel(u),
        url: null,
        defaultUrl: null,
        locked: locked.has('torznabUrls'),
      })),
      ...BUILTIN_XDCC_INDEXERS.map((b): SearchSourceDTO => {
        const edit = s.xdccIndexers[b.id];
        const url = edit?.url ?? b.url;
        return {
          id: b.id,
          kind: 'xdcc',
          name: b.name,
          enabled: edit?.enabled !== false,
          contentTypes: [],
          detail: new URL(url).host,
          url,
          defaultUrl: b.url,
          locked: locked.has('xdccIndexers'),
        };
      }),
      ...this.deps.sites.list().map((site): SearchSourceDTO => ({
        id: `site:${site.id}`,
        kind: 'site',
        name: site.name,
        enabled: site.enabled && site.searchUrls.length > 0,
        contentTypes: site.contentTypes,
        detail: site.searchUrls.length ? null : 'No search URL yet',
        url: null,
        defaultUrl: null,
        locked: false,
      })),
    ];
  }

  setBuiltinEnabled(id: string, enabled: boolean): void {
    if (isXdccIndexer(id)) {
      this.unlocked('xdccIndexers');
      const all = this.deps.settings.get().xdccIndexers;
      const { enabled: _, ...rest } = all[id] ?? {};
      const next = enabled ? rest : { ...rest, enabled: false };
      const { [id]: __, ...others } = all;
      this.deps.settings.update({
        xdccIndexers: Object.keys(next).length ? { ...others, [id]: next } : others,
      });
      return;
    }
    const key = isBuiltin(id) ? ENABLED_KEY[id] : null;
    if (!key) throw new CoreError('not_found', 'Unknown source');
    this.unlocked(key);
    this.deps.settings.update({ [key]: enabled });
  }

  /** Changes a built-in indexer's address or content, or a Torznab endpoint's URL. */
  editSource(id: string, edit: SourceEdit): void {
    const m = /^torznab:(\d+)$/.exec(id);
    if (m) {
      if (!edit.url) throw new CoreError('invalid_input', 'Enter the Torznab URL');
      this.unlocked('torznabUrls');
      const urls = parseTorznabUrls(this.deps.settings.get().torznabUrls);
      const index = Number(m[1]);
      if (!urls[index]) throw new CoreError('not_found', 'Indexer not found');
      const url = httpUrl(edit.url);
      if (urls.some((u, i) => i !== index && u === url))
        throw new CoreError('conflict', 'This indexer is already added');
      urls[index] = url;
      this.deps.settings.update({ torznabUrls: urls.join('\n') });
      return;
    }
    if (isXdccIndexer(id)) {
      this.unlocked('xdccIndexers');
      const def = BUILTIN_XDCC_INDEXERS.find((b) => b.id === id)!;
      const all = this.deps.settings.get().xdccIndexers;
      const next = { ...all[id] };
      if (edit.url !== undefined) {
        const url = edit.url ? siteAddress(edit.url) : null;
        if (url && url !== def.url) next.url = url;
        else delete next.url;
      }
      const { [id]: _, ...others } = all;
      this.deps.settings.update({
        xdccIndexers: Object.keys(next).length ? { ...others, [id]: next } : others,
      });
      return;
    }
    if (!isBuiltin(id)) throw new CoreError('not_found', 'Unknown source');
    const def = BUILTIN_INDEXERS.find((b) => b.id === id)!;
    const all = this.deps.settings.get().builtinIndexers;
    const next = { ...all[id] };
    if (edit.url !== undefined) {
      const url = edit.url ? siteAddress(edit.url) : null;
      if (url && url !== def.url) next.url = url;
      else delete next.url;
    }
    if (edit.contentTypes !== undefined) {
      const types = edit.contentTypes ? [...new Set(edit.contentTypes)] : null;
      if (types && !(types.length === 1 && types[0] === 'anime')) next.contentTypes = types;
      else delete next.contentTypes;
    }
    const { [id]: _, ...others } = all;
    this.deps.settings.update({
      builtinIndexers: Object.keys(next).length ? { ...others, [id]: next } : others,
    });
  }

  addTorznab(url: string): void {
    this.unlocked('torznabUrls');
    const urls = parseTorznabUrls(this.deps.settings.get().torznabUrls);
    const parsed = httpUrl(url);
    if (urls.includes(parsed)) throw new CoreError('conflict', 'This indexer is already added');
    this.deps.settings.update({ torznabUrls: [...urls, parsed].join('\n') });
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
    if (dto.kind === 'xdcc') {
      if (!dto.enabled)
        return { ok: false, total: 0, sample: [], error: 'This source is turned off' };
      const ix = this.xdccIndexers().find((x) => x.name === dto.name);
      try {
        const packs = (await ix?.search(query)) ?? [];
        return {
          ok: packs.length > 0,
          total: packs.length,
          sample: packs.slice(0, 5).map((p) => p.filename),
          error: packs.length ? null : 'The search worked but found nothing',
        };
      } catch (err) {
        return { ok: false, total: 0, sample: [], error: (err as Error).message };
      }
    }
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
