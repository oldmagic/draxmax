import type { SiteMapping } from '@draxmax/shared';
import { parseFeed } from '../rss/feed-parser.ts';
import { templateToRegex } from './templates.ts';

/** One search hit before its download link is built. */
export interface SiteHit {
  title: string;
  id: string | null;
  groupId: string | null;
  /** Link the response gave directly (magnet, .torrent, API download), if any. */
  link: string | null;
  seeders: number | null;
  size: number | null;
}

export interface ParsedSearch {
  format: 'json' | 'html' | 'rss';
  hits: SiteHit[];
  /** Field mapping used (detected or configured), for "use these mappings". */
  mapping: SiteMapping;
}

const MAX_TITLE = 512;

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

/** 1234, "1234", "1.4 GB", "700 MiB" → bytes. */
export function parseSize(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  if (typeof v !== 'string') return null;
  const m = /^\s*([\d.,]+)\s*([KMGT]i?B|B)?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,(?=\d{3}\b)/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * (m[2] ? (UNITS[m[2].toLowerCase()] ?? 1) : 1));
}

function toInt(v: unknown): number | null {
  const n =
    typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[,\s]/g, '')) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);

export function detectFormat(body: string, contentType: string): ParsedSearch['format'] {
  const head = body.trimStart().slice(0, 200).toLowerCase();
  if (/json/i.test(contentType) || head.startsWith('{') || head.startsWith('[')) return 'json';
  if (/xml|rss|atom/i.test(contentType) && !/html/i.test(contentType)) return 'rss';
  if (head.startsWith('<?xml') || head.startsWith('<rss') || head.startsWith('<feed')) return 'rss';
  return 'html';
}

// --- JSON ------------------------------------------------------------------------

type Obj = Record<string, unknown>;

/** Reads a dot path ("data.torrents", "files.0.name"). */
export function getPath(v: unknown, path: string): unknown {
  let cur = v;
  for (const key of path.split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Obj)[key];
  }
  return cur;
}

const CANDIDATES = {
  title: [
    'name',
    'title',
    'release_name',
    'releasename',
    'releaseName',
    'torrent_name',
    'filename',
    'file_name',
  ],
  id: ['id', 'torrent_id', 'torrentid', 'torrentId', 'tid'],
  groupId: ['group_id', 'groupid', 'groupId'],
  seeders: ['seeders', 'seeds', 'seed', 'seeders_count', 'seedercount'],
  size: ['size', 'bytes', 'total_size', 'filesize', 'file_size', 'size_bytes'],
  download: [
    'download',
    'download_url',
    'downloadurl',
    'downloadUrl',
    'download_link',
    'magnet',
    'magnet_uri',
    'magnetlink',
    'link',
    'url',
  ],
};

function findKey(o: Obj, names: string[], test: (v: unknown) => boolean): string | undefined {
  const keys = Object.keys(o);
  for (const n of names) {
    const k = keys.find((x) => x.toLowerCase() === n.toLowerCase());
    if (k && test(o[k])) return k;
  }
  return undefined;
}

/** Largest array of objects within a few levels (the result list), with its path. */
function findList(root: unknown): { path: string; items: Obj[] } | null {
  let best: { path: string; items: Obj[] } | null = null;
  const visit = (v: unknown, path: string, depth: number) => {
    if (depth > 4 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      const objs = v.filter((x): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x));
      const titled = objs.filter((o) => findKey(o, CANDIDATES.title, (x) => typeof x === 'string'));
      if (titled.length && (!best || titled.length > best.items.length))
        best = { path, items: objs };
      return;
    }
    for (const [k, child] of Object.entries(v)) visit(child, path ? `${path}.${k}` : k, depth + 1);
  };
  visit(root, '', 0);
  return best;
}

const isLinkish = (v: unknown) => typeof v === 'string' && /^(https?:\/\/|magnet:|\/)/i.test(v);

function parseJson(body: string, mapping: SiteMapping): ParsedSearch {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    throw new Error('The response is not valid JSON');
  }
  const found =
    mapping.list !== undefined
      ? { path: mapping.list, items: (getPath(root, mapping.list) as Obj[] | undefined) ?? [] }
      : Array.isArray(root)
        ? { path: '', items: root as Obj[] }
        : findList(root);
  if (!found || !Array.isArray(found.items))
    return { format: 'json', hits: [], mapping: { ...mapping, format: 'json' } };
  const sample = found.items.find((o) => o && typeof o === 'object') ?? {};
  const pick = (configured: string | undefined, names: string[], test: (v: unknown) => boolean) =>
    configured ?? findKey(sample, names, test);
  const used: SiteMapping = {
    format: 'json',
    list: found.path,
    title: pick(mapping.title, CANDIDATES.title, (v) => typeof v === 'string'),
    id: pick(mapping.id, CANDIDATES.id, (v) => typeof v === 'number' || typeof v === 'string'),
    groupId: pick(mapping.groupId, CANDIDATES.groupId, (v) => v != null),
    seeders: pick(mapping.seeders, CANDIDATES.seeders, (v) => toInt(v) !== null),
    size: pick(mapping.size, CANDIDATES.size, (v) => parseSize(v) !== null),
    download: pick(mapping.download, CANDIDATES.download, isLinkish),
  };
  const hits = found.items.flatMap((o): SiteHit[] => {
    const title = used.title ? getPath(o, used.title) : undefined;
    if (typeof title !== 'string' || !title.trim()) return [];
    const id = used.id ? getPath(o, used.id) : undefined;
    const group = used.groupId ? getPath(o, used.groupId) : undefined;
    const link = used.download ? getPath(o, used.download) : undefined;
    return [
      {
        title: clip(title),
        id: id === undefined || id === null ? null : String(id),
        groupId: group === undefined || group === null ? null : String(group),
        link: isLinkish(link) ? (link as string) : null,
        seeders: used.seeders ? toInt(getPath(o, used.seeders)) : null,
        size: used.size ? parseSize(getPath(o, used.size)) : null,
      },
    ];
  });
  return { format: 'json', hits, mapping: clean(used) };
}

function clean(m: SiteMapping): SiteMapping {
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) as SiteMapping;
}

// --- HTML ------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, ' '));

/**
 * Finds torrent links by the site's torrent-page pattern. The title is the link text (or
 * its title attribute); seeders and size are read best-effort from the same table row.
 */
function parseHtml(body: string, infoUrl: string, mapping: SiteMapping): ParsedSearch {
  const pattern = templateToRegex(infoUrl);
  if (!pattern)
    throw new Error('Set the torrent page link pattern (with {id}) to read HTML search pages');
  const byId = new Map<string, SiteHit>();
  const anchor = /<a\b([^>]*?)href\s*=\s*(?:"([^"]*)"|'([^']*)')([^>]*)>([\s\S]{0,2000}?)<\/a>/gi;
  for (const m of body.matchAll(anchor)) {
    const href = decodeEntities(m[2] ?? m[3] ?? '');
    const id = pattern.exec(href)?.groups?.id;
    if (!id) continue;
    const attrs = `${m[1]} ${m[4]}`;
    const titleAttr = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    let title = clip(stripTags(m[5] ?? ''));
    if (title.length < 3 && titleAttr)
      title = clip(decodeEntities(titleAttr[1] ?? titleAttr[2] ?? ''));
    if (title.length < 3) continue;
    const prev = byId.get(id);
    if (prev && prev.title.length >= title.length) continue;
    const row = rowAround(body, m.index ?? 0);
    byId.set(id, {
      title,
      id,
      groupId: null,
      link: directLink(row),
      seeders: rowSeeders(row),
      size: rowSize(row),
    });
  }
  return { format: 'html', hits: [...byId.values()], mapping: { ...mapping, format: 'html' } };
}

/** The <tr>…</tr> (or a 3 kB window) around a position. */
function rowAround(html: string, at: number): string {
  const start = html.lastIndexOf('<tr', at);
  const end = html.indexOf('</tr>', at);
  if (start !== -1 && end !== -1 && end - start < 20_000 && at - start < 10_000)
    return html.slice(start, end);
  return html.slice(Math.max(0, at - 1500), at + 1500);
}

function directLink(row: string): string | null {
  const magnet = /href\s*=\s*["'](magnet:\?[^"']+)["']/i.exec(row);
  if (magnet) return decodeEntities(magnet[1]!);
  const dl = /href\s*=\s*["']([^"']*(?:download|\.torrent)[^"']*)["']/i.exec(row);
  return dl ? decodeEntities(dl[1]!) : null;
}

function rowSeeders(row: string): number | null {
  const m =
    /<(?:td|span|div)[^>]*(?:class|title|data-[a-z-]+)\s*=\s*["'][^"']*seed[^"']*["'][^>]*>\s*(?:<[^>]+>\s*)*([\d,]+)/i.exec(
      row,
    );
  return m ? toInt(m[1]) : null;
}

function rowSize(row: string): number | null {
  const m = /(\d+(?:[.,]\d+)?)\s*(TiB|GiB|MiB|KiB|TB|GB|MB|KB)\b/i.exec(stripTags(row));
  return m ? parseSize(`${m[1]} ${m[2]}`) : null;
}

// --- RSS -------------------------------------------------------------------------

async function parseRss(body: string, mapping: SiteMapping): Promise<ParsedSearch> {
  const feed = await parseFeed(body).catch(() => {
    throw new Error('The response is not a valid RSS/Torznab feed');
  });
  return {
    format: 'rss',
    hits: feed.items.map((i) => ({
      title: clip(i.title),
      id: null,
      groupId: null,
      link: i.torrentURL,
      seeders: i.seeders,
      size: i.size,
    })),
    mapping: { ...mapping, format: 'rss' },
  };
}

/** Parses a search response by its configured or detected format. */
export async function parseSearch(
  body: string,
  contentType: string,
  opts: { infoUrl: string; mapping: SiteMapping },
): Promise<ParsedSearch> {
  const format =
    opts.mapping.format && opts.mapping.format !== 'auto'
      ? opts.mapping.format
      : detectFormat(body, contentType);
  if (format === 'json') return parseJson(body, opts.mapping);
  if (format === 'rss') return parseRss(body, opts.mapping);
  return parseHtml(body, opts.infoUrl, opts.mapping);
}
