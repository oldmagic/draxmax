/* eslint-disable no-control-regex -- IRC is built on control characters (CTCP \x01, mIRC colour codes). */
import { lookup } from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import { isPrivateAddress } from '../net/http.ts';

/** One parsed IRC protocol line. */
export interface IrcMessage {
  /** `nick!user@host` or a server name; '' when absent. */
  prefix: string;
  /** The nick part of the prefix. */
  nick: string;
  command: string;
  params: string[];
}

/** IRC lines are at most 512 bytes (8 KiB with IRCv3 tags); anything longer is hostile. */
const MAX_LINE = 16 * 1024;

export function parseIrcLine(raw: string): IrcMessage | null {
  let line = raw.replace(/[\r\n]+$/, '');
  // IRCv3 message tags: not requested, but skip them if a server sends any.
  if (line.startsWith('@')) {
    const sp = line.indexOf(' ');
    if (sp === -1) return null;
    line = line.slice(sp + 1);
  }
  let prefix = '';
  if (line.startsWith(':')) {
    const sp = line.indexOf(' ');
    if (sp === -1) return null;
    prefix = line.slice(1, sp);
    line = line.slice(sp + 1);
  }
  const params: string[] = [];
  let trailing: string | null = null;
  const t = line.indexOf(' :');
  if (t !== -1) {
    trailing = line.slice(t + 2);
    line = line.slice(0, t);
  }
  const parts = line.split(' ').filter(Boolean);
  const command = parts.shift()?.toUpperCase();
  if (!command) return null;
  params.push(...parts);
  if (trailing !== null) params.push(trailing);
  return { prefix, nick: prefix.split('!')[0] ?? '', command, params };
}

/** Removes mIRC colour, bold, underline etc. codes from text meant for people. */
export function stripFormatting(text: string): string {
  return text
    .replace(
      /\x03(\d{1,2}(,\d{1,2})?)?|\x04[0-9a-f]{6}(,[0-9a-f]{6})?|[\x02\x0f\x11\x16\x1d\x1e\x1f]/gi,
      '',
    )
    .replace(/[\x00-\x08\x0a-\x1f\x7f]/g, '')
    .trim();
}

/** Nicks, channels and the like may not contain characters that would split a command. */
const UNSAFE = /[\x00-\x20\x7f,]/;
export const isSafeNick = (s: string) =>
  s.length > 0 && s.length <= 64 && !UNSAFE.test(s) && !/[:!@#&]/.test(s[0]!) && !/[!@]/.test(s);
export const isSafeChannel = (s: string) =>
  /^[#&+!]/.test(s) && s.length <= 200 && !UNSAFE.test(s) && !s.includes('\x07');
export const isSafeHost = (s: string) =>
  s.length <= 253 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(s);

export class NetPolicyError extends Error {}

/**
 * Resolves `host` and connects to one of its addresses. Hosts and DCC addresses come from
 * third parties (search indexes, bots), so private, loopback and link-local addresses are
 * refused unless `allowPrivate`, and the connection goes to exactly the address checked.
 */
export async function connectTcp(
  host: string,
  port: number,
  opts: { tls?: boolean; verify?: boolean; allowPrivate?: boolean; timeoutMs?: number },
): Promise<net.Socket> {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new NetPolicyError(`Invalid port ${port}`);
  let address = host;
  if (!net.isIP(host)) {
    if (!isSafeHost(host)) throw new NetPolicyError(`Invalid host name ${host}`);
    let addrs: { address: string }[];
    try {
      addrs = await lookup(host, { all: true, verbatim: true });
    } catch {
      throw new Error(`Could not resolve ${host}`);
    }
    if (!addrs.length) throw new Error(`Could not resolve ${host}`);
    if (
      !opts.allowPrivate &&
      (host === 'localhost' || addrs.some((a) => isPrivateAddress(a.address)))
    )
      throw new NetPolicyError(`${host} is a local network address`);
    address = addrs[0]!.address;
  } else if (!opts.allowPrivate && isPrivateAddress(host)) {
    throw new NetPolicyError(`${host} is a local network address`);
  }
  return new Promise((resolve, reject) => {
    const sock = opts.tls
      ? tls.connect({
          host: address,
          port,
          // SNI and certificate checks use the name, while the connection uses the address.
          ...(net.isIP(host) ? {} : { servername: host }),
          rejectUnauthorized: opts.verify ?? true,
          checkServerIdentity: (_h, cert) => tls.checkServerIdentity(host, cert),
        })
      : net.connect({ host: address, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`Timed out connecting to ${host}:${port}`));
    }, opts.timeoutMs ?? 20_000);
    sock.once(opts.tls ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      sock.removeAllListeners('error');
      resolve(sock);
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    });
  });
}

export interface IrcOptions {
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  allowPrivate?: boolean;
  /** Reply to CTCP VERSION (many bots and networks ask). */
  version: string;
}

export interface IrcEvents {
  registered: [];
  message: [IrcMessage];
  /** A CTCP request (`\x01…\x01` in a PRIVMSG) other than VERSION/PING/TIME. */
  ctcp: [{ from: string; command: string; args: string }];
  notice: [{ from: string; text: string }];
  close: [Error | null];
}

/**
 * A minimal IRC client: registers, answers PINGs and common CTCP queries, and hands
 * everything else to its owner. One connection serves one XDCC transfer.
 */
export class IrcClient extends EventEmitter<IrcEvents> {
  private sock: net.Socket | null = null;
  private buf = '';
  private closed = false;
  nick: string;
  registered = false;

  constructor(private readonly opts: IrcOptions) {
    super();
    this.nick = opts.nick;
  }

  async connect(): Promise<void> {
    const { host, port } = this.opts;
    let sock: net.Socket;
    if (this.opts.tls) {
      try {
        sock = await connectTcp(host, port, { tls: true, allowPrivate: this.opts.allowPrivate });
      } catch (err) {
        // Many IRC networks use self-signed certificates. An unverified TLS link is still
        // no worse than the plain-text one the network would otherwise get.
        if (
          err instanceof NetPolicyError ||
          !/certificate|self.signed|unable to verify/i.test((err as Error).message)
        )
          throw err;
        sock = await connectTcp(host, port, {
          tls: true,
          verify: false,
          allowPrivate: this.opts.allowPrivate,
        });
      }
    } else {
      sock = await connectTcp(host, port, { allowPrivate: this.opts.allowPrivate });
    }
    if (this.closed) {
      sock.destroy();
      return;
    }
    this.sock = sock;
    sock.setEncoding('utf8');
    sock.setKeepAlive(true, 60_000);
    sock.on('data', (chunk: string) => this.onData(chunk));
    sock.on('error', (err) => this.finish(err));
    sock.on('close', () =>
      this.finish(this.registered ? null : new Error('The IRC server closed the connection')),
    );
    this.send(`NICK ${this.nick}`);
    this.send(`USER ${this.nick} 0 * :${this.nick}`);
  }

  send(line: string): void {
    // Never let a value carry a line break into a second command.
    if (/[\r\n\0]/.test(line)) throw new Error('Unsafe IRC line');
    if (this.sock && !this.sock.destroyed) this.sock.write(`${line}\r\n`);
  }

  privmsg(target: string, text: string): void {
    this.send(`PRIVMSG ${target} :${text}`);
  }

  ctcp(target: string, text: string): void {
    this.privmsg(target, `\x01${text}\x01`);
  }

  quit(reason = 'Bye'): void {
    if (this.closed) return;
    this.send(`QUIT :${reason}`);
    this.sock?.end();
    // Don't wait for a server that never closes its side.
    setTimeout(() => this.finish(null), 2000).unref();
  }

  destroy(): void {
    this.sock?.destroy();
    this.finish(null);
  }

  private finish(err: Error | null): void {
    if (this.closed) return;
    this.closed = true;
    this.sock?.destroy();
    this.emit('close', err);
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > MAX_LINE && !this.buf.includes('\n')) {
      this.finish(new Error('The IRC server sent an over-long line'));
      return;
    }
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const msg = parseIrcLine(line);
      if (msg) this.handle(msg);
      if (this.closed) return;
    }
  }

  private handle(m: IrcMessage): void {
    switch (m.command) {
      case 'PING':
        this.send(`PONG :${m.params[0] ?? ''}`);
        return;
      case '001':
        this.registered = true;
        if (m.params[0]) this.nick = m.params[0];
        this.emit('registered');
        break;
      case '432': // erroneous nickname
      case '433': // nickname in use
        if (!this.registered) {
          this.nick = `${this.opts.nick.slice(0, 12)}${Math.floor(Math.random() * 10_000)}`;
          this.send(`NICK ${this.nick}`);
        }
        break;
      case 'ERROR':
        this.finish(new Error(stripFormatting(m.params.at(-1) ?? 'Disconnected by the server')));
        return;
      case 'PRIVMSG': {
        const text = m.params[1] ?? '';
        const ctcp = /^\x01([A-Z]+) ?([^\x01]*)\x01?$/i.exec(text);
        if (ctcp && m.params[0] === this.nick) {
          const command = ctcp[1]!.toUpperCase();
          const args = ctcp[2] ?? '';
          if (!isSafeNick(m.nick)) break;
          if (command === 'VERSION')
            this.send(`NOTICE ${m.nick} :\x01VERSION ${this.opts.version}\x01`);
          else if (command === 'PING' && args.length < 64 && !/[\r\n]/.test(args))
            this.send(`NOTICE ${m.nick} :\x01PING ${args}\x01`);
          else if (command === 'TIME')
            this.send(`NOTICE ${m.nick} :\x01TIME ${new Date().toUTCString()}\x01`);
          else this.emit('ctcp', { from: m.nick, command, args });
          return;
        }
        if (m.params[0] === this.nick)
          this.emit('notice', { from: m.nick, text: stripFormatting(text) });
        break;
      }
      case 'NOTICE':
        if (m.params[0] === this.nick || m.params[0] === '*')
          this.emit('notice', { from: m.nick, text: stripFormatting(m.params[1] ?? '') });
        break;
    }
    this.emit('message', m);
  }
}
