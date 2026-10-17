import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { APP_NAME, APP_VERSION } from '@draxmax/shared';

export const USER_AGENT = `${APP_NAME}/${APP_VERSION}`;

export interface FetchOptions {
  timeoutMs?: number;
  /** Abort if the body exceeds this many bytes. */
  maxBytes?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  /**
   * May the first request target a private, loopback or link-local address? Default true:
   * admins point DraxMax at LAN services (Prowlarr). Use false for URLs that come from
   * third-party content (feed items, search results), so a malicious feed can't make the
   * server probe the local network (SSRF). Redirects from a public address never reach a
   * private one either way.
   */
  allowPrivate?: boolean;
  /** Return error responses (4xx/5xx) instead of throwing, e.g. to show them to the user. */
  acceptErrors?: boolean;
}

const MAX_REDIRECTS = 5;

/** Addresses that aren't the public internet. */
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const)
  PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 127],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  PRIVATE.addSubnet(net, bits, 'ipv6');

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return PRIVATE.check(ip, 'ipv4');
  if (v !== 6) return true;
  const lower = ip.toLowerCase();
  // IPv4-mapped / NAT64 forms carry an IPv4 address in the low 32 bits.
  const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return PRIVATE.check(mapped[1]!, 'ipv4');
  return PRIVATE.check(lower, 'ipv6');
}

interface Address {
  address: string;
  family: number;
}

/** The addresses a URL's host stands for, and whether any of them is non-public. */
async function resolveTarget(url: URL): Promise<{ addrs: Address[]; private: boolean }> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const v = isIP(host);
  if (v) return { addrs: [{ address: host, family: v }], private: isPrivateAddress(host) };
  let addrs: Address[];
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new HttpError(`Could not resolve ${url.host}`);
  }
  if (addrs.length === 0) throw new HttpError(`Could not resolve ${url.host}`);
  const local = host === 'localhost' || host.endsWith('.localhost');
  return { addrs, private: local || addrs.some((a) => isPrivateAddress(a.address)) };
}

export interface TransportRequest {
  method: string;
  headers: Record<string, string>;
  body?: string | undefined;
  signal: AbortSignal;
}
export interface TransportResponse {
  status: number;
  headers: Record<string, string | undefined>;
  /** Decoded body; destroy it to drop the connection. */
  body: Readable;
}

/**
 * One HTTP exchange, connecting only to `addrs`. The addresses were resolved and checked by
 * the caller; connecting to exactly those (instead of resolving the name a second time)
 * closes the DNS-rebinding gap, where a name answers "public" for the check and "127.0.0.1"
 * for the connection.
 */
function nodeRequest(
  target: URL,
  addrs: Address[],
  req: TransportRequest,
): Promise<TransportResponse> {
  const pinned: LookupFunction = (_host, options, cb) => {
    if (typeof options === 'object' && options.all) cb(null, addrs);
    else cb(null, addrs[0]!.address, addrs[0]!.family);
  };
  return new Promise((resolve, reject) => {
    const r = (target.protocol === 'https:' ? https : http).request(
      target,
      {
        method: req.method,
        headers: { 'accept-encoding': 'gzip, deflate, br', ...req.headers },
        lookup: pinned,
        signal: req.signal,
      },
      (res) => {
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
        const decoder =
          enc === 'gzip' || enc === 'x-gzip'
            ? createGunzip()
            : enc === 'deflate'
              ? createInflate()
              : enc === 'br'
                ? createBrotliDecompress()
                : null;
        if (decoder) {
          res.on('error', (err) => decoder.destroy(err));
          decoder.on('close', () => res.destroy());
        }
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers))
          headers[k] = Array.isArray(v) ? v.join(', ') : v;
        resolve({
          status: res.statusCode ?? 0,
          headers,
          body: decoder ? res.pipe(decoder) : res,
        });
      },
    );
    r.on('error', reject);
    r.end(req.body);
  });
}

/** Replaceable in tests. */
export const httpTransport = { request: nodeRequest };

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Seconds the server asked us to wait (Retry-After), if it said. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

/** fetch() with a timeout, a size cap and our User-Agent. Only http(s) URLs are allowed. */
export async function fetchBytes(
  url: string,
  opts: FetchOptions = {},
): Promise<{ body: Uint8Array; contentType: string; status: number }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(`Invalid URL: ${url}`);
  }
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  // Redirects are followed by hand so every hop is checked (scheme and address).
  let res: TransportResponse;
  let firstPrivate: boolean | null = null;
  const firstHost = parsed.host;
  for (let hop = 0; ; hop++) {
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      throw new HttpError(`Unsupported URL scheme: ${parsed.protocol}`);
    const resolved = await resolveTarget(parsed);
    const priv = resolved.private;
    if (firstPrivate === null) {
      firstPrivate = priv;
      if (priv && opts.allowPrivate === false)
        throw new HttpError(`Refusing to fetch ${parsed.host}: not a public address`);
    } else if (priv && !firstPrivate) {
      throw new HttpError(`Refusing redirect to ${parsed.host}: not a public address`);
    }
    const target = parsed;
    res = await httpTransport
      .request(target, resolved.addrs, {
        method: hop === 0 ? (opts.method ?? 'GET') : 'GET',
        // Cookies / auth headers only ever go to the host they were configured for.
        headers: {
          'user-agent': USER_AGENT,
          ...(hop === 0 || target.host === firstHost ? opts.headers : {}),
        },
        body: hop === 0 ? opts.body : undefined,
        signal,
      })
      .catch((err: Error) => {
        throw new HttpError(
          signal.aborted
            ? `Timed out fetching ${target.host}`
            : `Could not reach ${target.host}: ${err.message}`,
        );
      });
    const location = res.headers.location;
    if (res.status < 300 || res.status > 399 || !location) break;
    res.body.destroy();
    if (hop >= MAX_REDIRECTS) throw new HttpError(`Too many redirects from ${target.host}`);
    try {
      parsed = new URL(location, target);
    } catch {
      throw new HttpError(`Invalid redirect from ${target.host}`);
    }
  }
  const ok = res.status >= 200 && res.status < 300;
  if (!ok && !opts.acceptErrors) {
    res.body.destroy();
    const wait = Number(res.headers['retry-after']);
    throw new HttpError(
      `HTTP ${res.status} from ${parsed.host}`,
      res.status,
      Number.isFinite(wait) && wait > 0 ? wait : undefined,
    );
  }
  const declared = Number(res.headers['content-length'] ?? 0);
  if (declared > maxBytes) {
    res.body.destroy();
    throw new HttpError(`Response from ${parsed.host} is too large`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const value of res.body as AsyncIterable<Uint8Array>) {
      total += value.byteLength;
      // Counted after decompression, so a small "zip bomb" can't fill memory either.
      if (total > maxBytes) throw new HttpError(`Response from ${parsed.host} is too large`);
      chunks.push(value);
    }
  } catch (err) {
    res.body.destroy();
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      signal.aborted
        ? `Timed out fetching ${parsed.host}`
        : `Could not read the response from ${parsed.host}: ${(err as Error).message}`,
    );
  }
  return {
    body: Buffer.concat(chunks),
    contentType: res.headers['content-type'] ?? '',
    status: res.status,
  };
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const { body } = await fetchBytes(url, {
    ...opts,
    headers: { accept: 'application/json', ...opts.headers },
  });
  try {
    return JSON.parse(Buffer.from(body).toString('utf8')) as T;
  } catch {
    throw new HttpError(`Invalid JSON from ${new URL(url).host}`);
  }
}
