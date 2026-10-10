import type { ContentType } from '@draxmax/shared';
import { fetchBytes } from '../net/http.ts';
import { parseFeed } from '../rss/feed-parser.ts';

/** One release offered by a search source. */
export interface SearchResult {
  title: string;
  /** Magnet link or .torrent URL. */
  url: string;
  seeders: number | null;
  size: number | null;
  source: string;
  /** Download category the source wants for its torrents (a site's own). */
  category?: string;
}

export interface SearchSource {
  name: string;
  /** Anime-only indexers are skipped for live-action shows. */
  animeOnly: boolean;
  /** Kinds of content the source carries; empty or absent = everything. */
  types?: ContentType[];
  search(query: string): Promise<SearchResult[]>;
}

/**
 * Should `source` be asked about this kind of content? `null` means the kind isn't known
 * (e.g. a free-text search), which only rules out nothing.
 */
export function sourceCarries(source: SearchSource, kind: ContentType | null): boolean {
  if (kind === null) return true;
  if (source.animeOnly && kind !== 'anime') return false;
  return !source.types?.length || source.types.includes(kind);
}

/** A Torznab endpoint as shown to users: host and path, never its API key. */
export function torznabLabel(endpoint: string): string {
  const u = new URL(endpoint);
  return `${u.host}${u.pathname.replace(/\/api\/?$/, '').replace(/\/$/, '')}`;
}

export type FetchText = (url: string, accept: string) => Promise<string>;

export const defaultFetchText: FetchText = async (url, accept) => {
  const { body } = await fetchBytes(url, {
    maxBytes: 8 * 1024 * 1024,
    timeoutMs: 30_000,
    headers: { accept },
  });
  return Buffer.from(body).toString('utf8');
};

/** Serialises calls and keeps at least `ms` between them (be polite to public indexers). */
function paced<T>(ms: number, fn: (q: string) => Promise<T>): (q: string) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  let last = 0;
  return (q) => {
    const run = queue.then(async () => {
      const wait = last + ms - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fn(q);
    });
    queue = run.catch(() => undefined);
    return run;
  };
}

const RSS_ACCEPT = 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5';

async function searchRss(fetchText: FetchText, url: string, source: string) {
  const feed = await parseFeed(await fetchText(url, RSS_ACCEPT)).catch(() => {
    throw new Error(`${source} returned an invalid response`);
  });
  return feed.items.flatMap((i): SearchResult[] =>
    i.torrentURL
      ? [{ title: i.title, url: i.torrentURL, seeders: i.seeders, size: i.size, source }]
      : [],
  );
}

/** nyaa.si RSS search (anime, all languages). */
export function nyaaSource(fetchText: FetchText, intervalMs = 3_000): SearchSource {
  return {
    name: 'Nyaa',
    animeOnly: true,
    search: paced(intervalMs, (q) =>
      searchRss(
        fetchText,
        `https://nyaa.si/?page=rss&c=1_0&f=0&q=${encodeURIComponent(q)}`,
        'Nyaa',
      ),
    ),
  };
}

interface ToshoItem {
  title?: string;
  magnet_uri?: string | null;
  torrent_url?: string | null;
  info_hash?: string | null;
  seeders?: number | null;
  total_size?: number | null;
}

/** AnimeTosho JSON search (indexes Nyaa, TokyoTosho and others). */
export function animeToshoSource(fetchText: FetchText, intervalMs = 3_000): SearchSource {
  return {
    name: 'AnimeTosho',
    animeOnly: true,
    search: paced(intervalMs, async (q) => {
      const raw = await fetchText(
        `https://feed.animetosho.org/json?q=${encodeURIComponent(q)}`,
        'application/json',
      );
      let items: unknown;
      try {
        items = JSON.parse(raw);
      } catch {
        throw new Error('AnimeTosho returned an invalid response');
      }
      if (!Array.isArray(items)) return [];
      return (items as ToshoItem[]).flatMap((i): SearchResult[] => {
        const hash = i.info_hash && /^[0-9a-f]{40}$/i.test(i.info_hash) ? i.info_hash : null;
        const url =
          i.magnet_uri ||
          (hash ? `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(i.title ?? '')}` : null) ||
          i.torrent_url;
        if (!i.title || !url) return [];
        return [
          {
            title: i.title,
            url,
            seeders: typeof i.seeders === 'number' ? i.seeders : null,
            size: typeof i.total_size === 'number' ? i.total_size : null,
            source: 'AnimeTosho',
          },
        ];
      });
    }),
  };
}

/** A Torznab endpoint (Prowlarr, Jackett, or a tracker's own), e.g. `http://prowlarr:9696/1/api?apikey=…`. */
export function torznabSource(
  endpoint: string,
  fetchText: FetchText,
  intervalMs = 2_000,
): SearchSource {
  const base = new URL(endpoint);
  const name = `Torznab: ${torznabLabel(endpoint)}`;
  return {
    name,
    animeOnly: false,
    search: paced(intervalMs, (q) => {
      const url = new URL(base);
      url.searchParams.set('t', 'search');
      url.searchParams.set('q', q);
      return searchRss(fetchText, url.toString(), name);
    }),
  };
}

/** Splits the `torznabUrls` setting into valid http(s) URLs. */
export function parseTorznabUrls(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => {
      try {
        return /^https?:$/.test(new URL(s).protocol);
      } catch {
        return false;
      }
    });
}
