import { createHash } from 'node:crypto';
import Parser from 'rss-parser';
import { MAGNET_RE } from '@draxmax/shared';

export interface ParsedFeedItem {
  id: string;
  title: string;
  link: string;
  torrentURL: string | null;
  pubDate: Date;
  size: number | null;
  /** Seeders when the feed reports them (Nyaa, Torznab). */
  seeders: number | null;
}

export interface ParsedFeed {
  title: string;
  items: ParsedFeedItem[];
}

type Item = Record<string, unknown> & {
  title?: string;
  link?: string;
  guid?: string;
  id?: string;
  isoDate?: string;
  pubDate?: string;
  enclosure?: { url?: string; type?: string; length?: string | number };
};

const parser = new Parser<Record<string, unknown>, Item>({
  customFields: {
    item: [
      ['torrent:magnetURI', 'magnetURI'],
      ['torrent:infoHash', 'torrentInfoHash'],
      ['torrent:contentLength', 'contentLength'],
      ['nyaa:infoHash', 'nyaaInfoHash'],
      ['nyaa:size', 'nyaaSize'],
      ['nyaa:seeders', 'nyaaSeeders'],
      ['torznab:attr', 'torznabAttrs', { keepArray: true }],
    ],
  },
});

const looksLikeTorrent = (url: string | undefined): url is string =>
  !!url && (MAGNET_RE.test(url) || /\.torrent(\?|$)/i.test(url) || /\/download\/\d+/.test(url));

function text(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (v && typeof v === 'object' && '_' in v) return text((v as { _: unknown })._);
  return undefined;
}

/** Picks the most specific torrent link an item offers. */
export function extractTorrentUrl(item: Item): string | null {
  const enc = item.enclosure;
  if (enc?.url && (enc.type === 'application/x-bittorrent' || looksLikeTorrent(enc.url)))
    return enc.url;
  const magnet = text(item.magnetURI) ?? torznabAttr(item, 'magneturl');
  if (magnet && MAGNET_RE.test(magnet)) return magnet;
  if (looksLikeTorrent(item.link)) return item.link!;
  if (item.guid && MAGNET_RE.test(item.guid)) return item.guid;
  const hash = text(item.nyaaInfoHash) ?? text(item.torrentInfoHash);
  if (hash && /^[0-9a-f]{40}$/i.test(hash)) {
    return `magnet:?xt=urn:btih:${hash.toLowerCase()}&dn=${encodeURIComponent(item.title ?? '')}`;
  }
  if (enc?.url) return enc.url;
  return null;
}

const UNITS: Record<string, number> = {
  b: 1,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
};

function parseSize(item: Item): number | null {
  const len = Number(item.enclosure?.length ?? text(item.contentLength) ?? NaN);
  if (Number.isFinite(len) && len > 0) return len;
  const human = text(item.nyaaSize);
  const m = human && /^([\d.]+)\s*([KMGT]i?B|B)$/i.exec(human);
  if (m) return Math.round(Number(m[1]) * (UNITS[m[2]!.toLowerCase()] ?? 1));
  return null;
}

/** `<torznab:attr name="…" value="…"/>` lookup. */
function torznabAttr(item: Item, name: string): string | undefined {
  const attrs = item.torznabAttrs;
  if (!Array.isArray(attrs)) return undefined;
  for (const a of attrs as { $?: { name?: string; value?: string } }[])
    if (a?.$?.name?.toLowerCase() === name) return a.$.value;
  return undefined;
}

function parseSeeders(item: Item): number | null {
  const n = Number(text(item.nyaaSeeders) ?? torznabAttr(item, 'seeders') ?? NaN);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Parses RSS/Atom XML into items with stable ids and extracted torrent links. */
export async function parseFeed(xml: string): Promise<ParsedFeed> {
  const feed = await parser.parseString(xml);
  const items = (feed.items ?? []).map((item): ParsedFeedItem => {
    const title = (item.title ?? '').trim() || '(untitled)';
    const date = item.isoDate ?? item.pubDate;
    const pubDate = date && !Number.isNaN(Date.parse(date)) ? new Date(date) : new Date();
    const id =
      item.guid?.toString().trim() ||
      item.id?.toString().trim() ||
      item.link?.trim() ||
      createHash('sha1')
        .update(`${title}|${date ?? ''}`)
        .digest('hex');
    return {
      id: id.slice(0, 512),
      title,
      link: item.link ?? '',
      torrentURL: extractTorrentUrl(item),
      pubDate,
      size: parseSize(item),
      seeders: parseSeeders(item),
    };
  });
  return { title: (typeof feed.title === 'string' && feed.title.trim()) || '', items };
}
