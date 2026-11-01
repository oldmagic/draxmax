/* eslint-disable no-control-regex -- IRC is built on control characters (CTCP \x01, mIRC colour codes). */
import { createWriteStream, type WriteStream } from 'node:fs';
import net from 'node:net';
import { connectTcp } from './irc.ts';

/** A `DCC SEND` offer: the bot asks us to connect to it and fetch a file. */
export interface DccOffer {
  filename: string;
  host: string;
  port: number;
  /** Bytes; null when the bot doesn't say. */
  size: number | null;
  /** Set on passive (reverse) offers, where the bot wants to connect to us instead. */
  token: string | null;
}

/** Splits CTCP arguments, honouring "quoted names with spaces". */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args))) out.push(m[1] ?? m[2]!);
  return out;
}

/** The IP in an offer: a 32-bit integer (classic IPv4) or an IPv4/IPv6 literal. */
function parseDccHost(raw: string): string | null {
  if (/^\d{1,10}$/.test(raw)) {
    const n = Number(raw);
    // Below 1.0.0.0 it's a port or size that slipped into this position, not an address.
    if (n > 0xffffffff || n < 0x1000000) return null;
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  }
  return net.isIP(raw) ? raw : null;
}

/** Parses the arguments of a `DCC SEND`; null when it isn't a usable offer. */
export function parseDccSend(args: string): DccOffer | null {
  const parts = splitArgs(args);
  if (parts[0]?.toUpperCase() !== 'SEND' || parts.length < 4) return null;
  // Unquoted names with spaces arrive as several words: the last 3–5 fields are numeric.
  let tail = parts.slice(1);
  let token: string | null = null;
  let size: number | null = null;

  let hostRaw: string;
  let portRaw: string;
  const isNum = (s: string | undefined) => s !== undefined && /^\d+$/.test(s);
  // Forms: name ip port | name ip port size | name ip port size token
  if (
    tail.length >= 5 &&
    isNum(tail.at(-1)) &&
    isNum(tail.at(-2)) &&
    isNum(tail.at(-3)) &&
    parseDccHost(tail.at(-4)!) &&
    Number(tail.at(-3)) === 0
  ) {
    token = tail.at(-1)!;
    size = Number(tail.at(-2));
    portRaw = tail.at(-3)!;
    hostRaw = tail.at(-4)!;
    tail = tail.slice(0, -4);
  } else if (
    tail.length >= 4 &&
    isNum(tail.at(-1)) &&
    isNum(tail.at(-2)) &&
    parseDccHost(tail.at(-3)!)
  ) {
    size = Number(tail.at(-1));
    portRaw = tail.at(-2)!;
    hostRaw = tail.at(-3)!;
    tail = tail.slice(0, -3);
  } else if (tail.length >= 3 && isNum(tail.at(-1)) && parseDccHost(tail.at(-2)!)) {
    portRaw = tail.at(-1)!;
    hostRaw = tail.at(-2)!;
    tail = tail.slice(0, -2);
  } else return null;
  const filename = tail.join(' ');
  const host = parseDccHost(hostRaw);
  const port = Number(portRaw);
  if (!host || !filename || port > 65535) return null;
  if (port === 0 && token === null) token = '';
  if (size !== null && !Number.isSafeInteger(size)) return null;
  return { filename, host, port, size: size || null, token };
}

/** Parses `DCC ACCEPT <file> <port> <position>`; the bot agreed to resume. */
export function parseDccAccept(args: string): { port: number; position: number } | null {
  const parts = splitArgs(args);
  if (parts[0]?.toUpperCase() !== 'ACCEPT' || parts.length < 4) return null;
  // Port and position are the last two numbers (a token may follow on passive offers).
  const nums = parts.slice(2).filter((p) => /^\d+$/.test(p));
  const port = Number(nums.at(-2));
  const position = Number(nums.at(-1));
  if (!Number.isSafeInteger(position) || !Number.isInteger(port)) return null;
  return { port, position };
}

/** Windows reserves these as file names on every drive. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * Makes a bot-supplied file name safe to create: no folders, no `..`, no control or
 * shell-hostile characters, not hidden, and at most 200 bytes. Falls back to `fallback`.
 */
export function safeFilename(raw: string, fallback: string): string {
  let name = raw.split(/[/\\]/).at(-1) ?? '';
  name = name
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .replace(/\s+/g, ' ');
  if (RESERVED.test(name)) name = `_${name}`;
  while (Buffer.byteLength(name) > 200) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, name.length - ext.length - 1) + ext;
  }
  return name || fallback;
}

export interface ReceiveOptions {
  host: string;
  port: number;
  /** Where the bytes go; opened for appending at `offset`. */
  path: string;
  offset: number;
  size: number;
  allowPrivate?: boolean;
  signal: AbortSignal;
  /** Called with the total bytes on disk as data arrives. */
  onProgress(total: number): void;
  /** No data for this long ends the transfer as stalled. */
  stallMs?: number;
}

/**
 * Connects to the bot and writes the file. Sends the classic 32-bit position
 * acknowledgements some bots wait for. Resolves once `size` bytes are on disk.
 */
export async function receiveFile(o: ReceiveOptions): Promise<void> {
  const sock = await connectTcp(o.host, o.port, {
    allowPrivate: o.allowPrivate,
    timeoutMs: 30_000,
  });
  const out: WriteStream = createWriteStream(o.path, {
    flags: o.offset > 0 ? 'r+' : 'w',
    start: o.offset,
    mode: 0o644,
  });
  let total = o.offset;
  const ack = Buffer.alloc(4);
  return new Promise<void>((resolve, reject) => {
    let done = false;
    let stall: NodeJS.Timeout | null = null;
    const finish = (err: Error | null) => {
      if (done) return;
      done = true;
      if (stall) clearTimeout(stall);
      o.signal.removeEventListener('abort', onAbort);
      sock.destroy();
      // Wait for the file to be flushed and closed before reporting.
      out.end(() => (err ? reject(err) : resolve()));
    };
    const armStall = () => {
      if (stall) clearTimeout(stall);
      stall = setTimeout(() => finish(new Error('The bot stopped sending')), o.stallMs ?? 120_000);
    };
    const onAbort = () => finish(new Error('Cancelled'));
    o.signal.addEventListener('abort', onAbort, { once: true });
    if (o.signal.aborted) return onAbort();
    armStall();
    out.on('error', (err) => finish(err));
    sock.on('data', (chunk: Buffer) => {
      if (done) return;
      armStall();
      // Never write past the size the bot announced.
      const room = o.size - total;
      const data = chunk.length > room ? chunk.subarray(0, room) : chunk;
      total += data.length;
      if (!out.write(data)) {
        sock.pause();
        out.once('drain', () => sock.resume());
      }
      ack.writeUInt32BE(total % 0x1_0000_0000);
      sock.write(ack);
      o.onProgress(total);
      if (total >= o.size) finish(null);
    });
    sock.on('error', (err) => finish(err));
    sock.on('close', () =>
      finish(total >= o.size ? null : new Error('The bot closed the connection before the end')),
    );
  });
}
