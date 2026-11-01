import { fetchJson } from '../net/http.ts';
import { isSafeChannel, isSafeHost, isSafeNick } from './irc.ts';

/** A pack found by an XDCC index, with everything needed to request it. */
export interface XdccPack {
  filename: string;
  size: number | null;
  network: string;
  host: string;
  port: number;
  tls: boolean;
  bot: string;
  channel: string | null;
  pack: number;
  gets: number | null;
  lastSeen: string | null;
  source: string;
}

export interface XdccIndexer {
  name: string;
  search(query: string): Promise<XdccPack[]>;
}

export type FetchJson = <T>(url: string) => Promise<T>;

const defaultFetch: FetchJson = (url) =>
  fetchJson(url, { timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024, allowPrivate: false });

interface InfoHit {
  pack_num?: unknown;
  filename?: unknown;
  filesize?: unknown;
  gets?: unknown;
  bot?: unknown;
  bot_channel?: unknown;
  network?: unknown;
  network_address?: unknown;
  last_seen?: unknown;
}
interface InfoNetwork {
  name?: unknown;
  address?: unknown;
  port?: unknown;
  use_ssl?: unknown;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const int = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** `2025-11-14 08:32:11` (UTC) as ISO, or null. */
function isoTime(v: unknown): string | null {
  const s = str(v);
  if (!/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d/.test(s)) return null;
  const d = new Date(`${s.slice(0, 10)}T${s.slice(11, 19)}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const NETWORKS_TTL_MS = 6 * 3600_000;

/**
 * xdcc.info's public JSON API (https://xdcc.info/api-docs). Search results name the network
 * address only; the port and TLS come from its network list, fetched now and then.
 */
export function xdccInfoIndexer(baseUrl: string, fetch: FetchJson = defaultFetch): XdccIndexer {
  const base = baseUrl.replace(/\/+$/, '');
  let networks: { at: number; byName: Map<string, { port: number; tls: boolean }> } | null = null;
  const networkInfo = async () => {
    if (networks && Date.now() - networks.at < NETWORKS_TTL_MS) return networks.byName;
    const byName = new Map<string, { port: number; tls: boolean }>();
    try {
      const list = await fetch<InfoNetwork[]>(`${base}/api/v1/networks`);
      for (const n of Array.isArray(list) ? list : []) {
        const port = int(n.port);
        if (!port || port > 65535) continue;
        const tls = n.use_ssl === 1 || n.use_ssl === true;
        for (const key of [str(n.name), str(n.address)])
          if (key) byName.set(key.toLowerCase(), { port, tls });
      }
      networks = { at: Date.now(), byName };
    } catch {
      // Search still works; requests then guess the usual TLS port.
    }
    return byName;
  };

  return {
    name: 'xdcc.info',
    async search(query) {
      const [res, nets] = await Promise.all([
        fetch<{ results?: InfoHit[]; error?: string }>(
          `${base}/api/v1/search?q=${encodeURIComponent(query)}&limit=100`,
        ),
        networkInfo(),
      ]);
      if (res && typeof res.error === 'string') throw new Error(res.error);
      const out: XdccPack[] = [];
      for (const h of Array.isArray(res?.results) ? res.results : []) {
        const filename = str(h.filename);
        const bot = str(h.bot);
        const host = str(h.network_address).toLowerCase();
        const pack = int(h.pack_num);
        const channel = str(h.bot_channel);
        // Everything here is put on an IRC command line later: keep only well-formed values.
        if (!filename || !pack || !isSafeNick(bot) || !isSafeHost(host)) continue;
        const network = str(h.network) || host;
        const net = nets.get(network.toLowerCase()) ?? nets.get(host);
        out.push({
          filename,
          size: int(h.filesize),
          network,
          host,
          port: net?.port ?? 6697,
          tls: net?.tls ?? true,
          bot,
          channel: channel && isSafeChannel(channel) ? channel : null,
          pack,
          gets: int(h.gets),
          lastSeen: isoTime(h.last_seen),
          source: 'xdcc.info',
        });
      }
      return out;
    },
  };
}
