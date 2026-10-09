import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { hostname } from 'node:os';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Core } from '@draxmax/core';

export const SESSION_COOKIE = 'draxmax_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 60_000;

/** `scrypt$<salt b64>$<hash b64>` */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  return (
    ip === '::1' ||
    ip.startsWith('127.') ||
    ip === '::ffff:127.0.0.1' ||
    ip.startsWith('::ffff:127.')
  );
}

/** Host part of a Host header ("[::1]:8895" → "::1", "example.org:80" → "example.org"). */
export function hostOf(header: string | undefined): string {
  if (!header) return '';
  const h = header.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.replace(/:\d+$/, '');
}

/**
 * Whether a Host header can be trusted for "local machine" access. DNS rebinding points an
 * attacker's domain (e.g. evil.example) at 127.0.0.1, so the browser sends that domain as
 * Host. Real local access uses an IP, `localhost`, or this machine's (dot-less) name.
 */
export function isLocalHostHeader(header: string | undefined): boolean {
  const h = hostOf(header);
  if (!h) return true; // HTTP/1.0 clients and tools without a Host header.
  if (isIP(h)) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const self = hostname().toLowerCase();
  return h === self || h === self.split('.')[0] || !h.includes('.');
}

export interface AuthOptions {
  /** Per-launch API token (desktop) or `API_TOKEN` env. */
  token?: string | undefined;
  /** Plain password from `WEBUI_PASSWORD`; hashed in memory, never stored. */
  envPassword?: string | undefined;
  /** Disable all auth (e.g. behind an authenticating reverse proxy). */
  disabled?: boolean | undefined;
}

export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
  /** No login exists yet and this client is remote: it must create one before using the API. */
  setupRequired: boolean;
  /** Creating that login from here needs the one-time setup code from the server log. */
  setupCodeRequired: boolean;
  username: string | null;
  /** Credentials come from environment variables and can't be changed in the UI. */
  managedByEnv: boolean;
}

/**
 * Web UI authentication:
 * - API token (Bearer header or `?token=`) always works; the desktop app uses this.
 * - If a username/password is configured, everything else needs a session cookie.
 * - If none is configured, loopback clients are trusted, and remote clients must first
 *   create credentials (first-run "secure your Web UI" step).
 */
export class AuthService {
  private readonly sessions = new Map<string, number>();
  private readonly failures = new Map<string, { count: number; since: number }>();
  private readonly envHash: string | null;
  /**
   * One-time code a remote client must give to create the first login. Without it, anyone
   * who reaches a fresh instance (internet, port-forward, Docker bridge where every client
   * looks local-network) could claim it before the owner does.
   */
  readonly setupCode = randomBytes(6).toString('hex').toUpperCase();

  constructor(
    private readonly core: Core,
    private readonly opts: AuthOptions = {},
  ) {
    this.envHash = opts.envPassword ? hashPassword(opts.envPassword) : null;
  }

  private passwordHash(): string {
    return this.envHash ?? this.core.settings.get().webuiPasswordHash;
  }

  configured(): boolean {
    return this.core.settings.get().webuiUsername !== '' && this.passwordHash() !== '';
  }

  managedByEnv(): boolean {
    return this.envHash !== null;
  }

  isTokenRequest(req: FastifyRequest): boolean {
    return this.tokenOk(req);
  }

  private tokenOk(req: FastifyRequest): boolean {
    if (!this.opts.token) return false;
    const header = req.headers.authorization;
    const q = req.query as Record<string, unknown> | undefined;
    const given = header?.startsWith('Bearer ')
      ? header.slice(7)
      : typeof q?.token === 'string'
        ? q.token
        : '';
    return given !== '' && safeEqual(this.opts.token, given);
  }

  private sessionOk(req: FastifyRequest): boolean {
    const sid = req.cookies?.[SESSION_COOKIE];
    if (!sid) return false;
    const exp = this.sessions.get(sid);
    if (!exp || exp < Date.now()) {
      this.sessions.delete(sid);
      return false;
    }
    this.sessions.set(sid, Date.now() + SESSION_TTL_MS);
    return true;
  }

  status(req: FastifyRequest): AuthStatus {
    const configured = this.configured();
    const authenticated = this.isAuthorized(req);
    return {
      configured,
      authenticated,
      setupRequired: !configured && !authenticated,
      setupCodeRequired: !configured && !this.isLocal(req),
      username: configured ? this.core.settings.get().webuiUsername : null,
      managedByEnv: this.managedByEnv(),
    };
  }

  /** Whether this request may use the API. */
  isAuthorized(req: FastifyRequest): boolean {
    if (this.opts.disabled) return true;
    if (this.tokenOk(req)) return true;
    if (this.configured()) return this.sessionOk(req);
    // No credentials yet: only the local machine is trusted.
    return this.isLocal(req);
  }

  /**
   * A request from this machine: loopback, not proxied (a proxy may forward anyone even
   * though it connects over loopback), and not a DNS-rebinding page (Host must be local).
   */
  isLocal(req: FastifyRequest): boolean {
    const proxied =
      'x-forwarded-for' in req.headers || 'forwarded' in req.headers || 'x-real-ip' in req.headers;
    return !proxied && isLoopback(req.ip) && isLocalHostHeader(req.headers.host);
  }

  /** First-login creation: always from this machine, otherwise with the setup code. */
  setupAllowed(req: FastifyRequest, code: string | undefined): boolean {
    if (this.isLocal(req) || this.tokenOk(req)) return true;
    return !!code && safeEqual(code.trim().toUpperCase(), this.setupCode);
  }

  /** Checks credentials with per-IP rate limiting (shared by login and sensitive changes). */
  checkCredentials(
    req: FastifyRequest,
    username: string,
    password: string,
  ): 'ok' | 'wrong' | 'rate_limited' {
    const ip = req.ip;
    // Bounded memory: forget expired entries once the table grows.
    if (this.failures.size > 1000)
      for (const [k, v] of this.failures)
        if (Date.now() - v.since >= FAILURE_WINDOW_MS) this.failures.delete(k);
    const f = this.failures.get(ip);
    if (f && Date.now() - f.since < FAILURE_WINDOW_MS && f.count >= MAX_FAILURES)
      return 'rate_limited';
    // Always run the (slow) password check so timing doesn't reveal valid usernames.
    const passwordOk = this.configured() && verifyPassword(password, this.passwordHash());
    const ok = safeEqual(username, this.core.settings.get().webuiUsername) && passwordOk;
    if (!ok) {
      const cur =
        f && Date.now() - f.since < FAILURE_WINDOW_MS ? f : { count: 0, since: Date.now() };
      cur.count++;
      this.failures.set(ip, cur);
      return 'wrong';
    }
    this.failures.delete(ip);
    return 'ok';
  }

  /** Returns a new session id on success. */
  login(req: FastifyRequest, username: string, password: string): string | 'rate_limited' | null {
    const res = this.checkCredentials(req, username, password);
    return res === 'ok' ? this.createSession() : res === 'rate_limited' ? res : null;
  }

  /**
   * Re-authentication for changing or removing the login, so a stolen session (or a
   * moment at an unlocked screen) can't lock the owner out. The API token and env-managed
   * setups skip it; so does a login that doesn't exist yet.
   */
  confirmCurrent(
    req: FastifyRequest,
    password: string | undefined,
  ): 'ok' | 'wrong' | 'rate_limited' {
    if (!this.configured() || this.tokenOk(req)) return 'ok';
    return this.checkCredentials(req, this.core.settings.get().webuiUsername, password ?? '');
  }

  createSession(): string {
    const sid = randomBytes(32).toString('base64url');
    this.sessions.set(sid, Date.now() + SESSION_TTL_MS);
    return sid;
  }

  logout(req: FastifyRequest): void {
    const sid = req.cookies?.[SESSION_COOKIE];
    if (sid) this.sessions.delete(sid);
  }

  /** Stores new credentials and invalidates every existing session. */
  setCredentials(username: string, password: string): void {
    if (this.managedByEnv())
      throw new Error('Credentials are set by WEBUI_USERNAME / WEBUI_PASSWORD');
    this.core.settings.update({
      webuiUsername: username,
      webuiPasswordHash: hashPassword(password),
    });
    this.sessions.clear();
  }

  /** Removes the login (only allowed from loopback or with the API token). */
  clearCredentials(): void {
    if (this.managedByEnv())
      throw new Error('Credentials are set by WEBUI_USERNAME / WEBUI_PASSWORD');
    this.core.settings.update({ webuiUsername: '', webuiPasswordHash: '' });
    this.sessions.clear();
  }

  setCookie(req: FastifyRequest, reply: FastifyReply, sid: string): void {
    reply.setCookie(SESSION_COOKIE, sid, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      // Behind a TLS-terminating proxy the hop to us is plain HTTP; trust its header for the
      // Secure flag only (a forged value can at worst stop this client's own login working).
      secure: req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https',
      maxAge: SESSION_TTL_MS / 1000,
    });
  }
}
