import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
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

/** Whether a URL's host is (or resolves to) a non-public address. */
async function resolvesPrivate(url: URL): Promise<boolean> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return isPrivateAddress(host);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  let addrs;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new HttpError(`Could not resolve ${url.host}`);
  }
  return addrs.some((a) => isPrivateAddress(a.address));
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
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
  let res: Response;
  let firstPrivate: boolean | null = null;
  const firstHost = parsed.host;
  for (let hop = 0; ; hop++) {
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      throw new HttpError(`Unsupported URL scheme: ${parsed.protocol}`);
    const priv = await resolvesPrivate(parsed);
    if (firstPrivate === null) {
      firstPrivate = priv;
      if (priv && opts.allowPrivate === false)
        throw new HttpError(`Refusing to fetch ${parsed.host}: not a public address`);
    } else if (priv && !firstPrivate) {
      throw new HttpError(`Refusing redirect to ${parsed.host}: not a public address`);
    }
    const target = parsed;
    res = await fetch(target, {
      method: hop === 0 ? (opts.method ?? 'GET') : 'GET',
      // Cookies / auth headers only ever go to the host they were configured for.
      headers: {
        'user-agent': USER_AGENT,
        ...(hop === 0 || target.host === firstHost ? opts.headers : {}),
      },
      body: hop === 0 ? opts.body : undefined,
      redirect: 'manual',
      signal,
    }).catch((err: Error) => {
      throw new HttpError(
        err.name === 'TimeoutError'
          ? `Timed out fetching ${target.host}`
          : `Could not reach ${target.host}: ${err.message}`,
      );
    });
    const location = res.headers.get('location');
    if (res.status < 300 || res.status > 399 || !location) break;
    if (hop >= MAX_REDIRECTS) throw new HttpError(`Too many redirects from ${target.host}`);
    await res.body?.cancel();
    try {
      parsed = new URL(location, target);
    } catch {
      throw new HttpError(`Invalid redirect from ${target.host}`);
    }
  }
  if (!res.ok && !opts.acceptErrors)
    throw new HttpError(`HTTP ${res.status} from ${parsed.host}`, res.status);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new HttpError(`Response from ${parsed.host} is too large`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HttpError(`Response from ${parsed.host} is too large`);
      }
      chunks.push(value);
    }
  }
  return {
    body: Buffer.concat(chunks),
    contentType: res.headers.get('content-type') ?? '',
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
