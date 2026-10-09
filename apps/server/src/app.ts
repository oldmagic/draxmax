import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket, { type WebSocket } from '@fastify/websocket';
import { existsSync } from 'node:fs';
import { z, ZodError } from 'zod';
import { CoreError, type Core } from '@draxmax/core';
import { APP_VERSION, type HealthResponse, type ServerEvent } from '@draxmax/shared';
import { AuthService, type AuthOptions } from './auth.ts';
import { authRoutes } from './routes/auth.ts';
import { fsRoutes } from './routes/fs.ts';
import { rssRoutes } from './routes/rss.ts';
import { mediaRoutes } from './routes/media.ts';
import { settingsRoutes, type IdentityOptions } from './routes/settings.ts';
import { siteRoutes } from './routes/sites.ts';
import { notificationRoutes } from './routes/notifications.ts';
import { torrentRoutes } from './routes/torrents.ts';

export interface ServerOptions {
  core: Core;
  /** Directory of the built Web UI. Omit to serve the API only. */
  webRoot?: string | undefined;
  /** When set, this token authorizes any API/WS request (Bearer header or `?token=`). */
  token?: string | undefined;
  auth?: Omit<AuthOptions, 'token'>;
  /** Interval for pushing live torrent snapshots over WebSocket. */
  snapshotIntervalMs?: number;
  logger?: boolean | { level: string };
  /** How "run as" user/group changes can be applied (see routes/settings.ts). */
  identity?: IdentityOptions;
}

const STATUS_BY_CODE = { invalid_input: 400, not_found: 404, conflict: 409 } as const;

/** Strict CSP for the Web UI; styles allow inline because animation libraries set style attributes. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

/** Removes credentials from URLs before they're logged. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:token|apikey|passkey)=)[^&#]*/gi, '$1[redacted]');
}

/** Decodes a URL path for policy checks; malformed escapes count as "/api" to stay closed. */
function decodedPath(url: string): string {
  const path = url.split('?')[0]!;
  try {
    return decodeURIComponent(path);
  } catch {
    return '/api/';
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Endpoints reachable without authorization. */
const PUBLIC_API = new Set([
  '/api/health',
  '/api/auth/status',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/setup',
]);

/** Live event fan-out to connected WebSocket clients. */
export interface Hub {
  broadcast(event: ServerEvent): void;
  readonly clientCount: number;
}

declare module 'fastify' {
  interface FastifyInstance {
    hub: Hub;
    auth: AuthService;
  }
}

/**
 * Builds the HTTP + WebSocket server around a core instance. Used by the headless daemon
 * and embedded by the Electron app, so both share one API surface.
 */
export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const { core } = opts;
  const logger =
    opts.logger && typeof opts.logger === 'object'
      ? {
          ...opts.logger,
          // API tokens may travel as `?token=` (desktop app); keep them out of logs.
          serializers: {
            req: (req: { method: string; url: string; ip?: string }) => ({
              method: req.method,
              url: redactUrl(req.url),
              remoteAddress: req.ip,
            }),
          },
        }
      : (opts.logger ?? false);
  const app = Fastify({ logger, bodyLimit: 24 * 1024 * 1024 });
  const startedAt = Date.now();
  const auth = new AuthService(core, { ...opts.auth, token: opts.token });
  app.decorate('auth', auth);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof CoreError) {
      return reply.status(STATUS_BY_CODE[err.code]).send({ error: err.message });
    }
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const message = first
        ? `${first.path.join('.') || 'request'}: ${first.message}`
        : 'Invalid request';
      return reply.status(400).send({ error: message, details: z.treeifyError(err) });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply
      .status(status)
      .send({ error: status >= 500 ? 'Internal error' : (err as Error).message });
  });

  await app.register(fastifyCookie);
  // Must come before the auth hook: the plugin's own hooks close upgrade sockets that get a
  // plain HTTP reply (e.g. 401). Registered after it, every rejected /api/ws leaked a socket.
  // Clients never send anything large; don't let one make the server buffer 100 MB (ws default).
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });

  app.addHook('onRequest', async (req, reply) => {
    // Decide by the route that matched, not the raw URL: the router decodes %-escapes, so
    // "/%61pi/settings" reaches "/api/settings" while not starting with "/api/".
    const route = req.routeOptions.url;
    const path = decodedPath(req.url);
    const isApi = (route ?? path).toLowerCase().startsWith('/api') || /^\/+api\b/i.test(path);
    if (!isApi) return;

    // Cross-site requests: browsers attach Origin / Sec-Fetch-Site. A page on another site
    // must never drive the API (CSRF), including through a WebSocket (CSWSH) or while the
    // local machine is trusted without a login.
    if (!SAFE_METHODS.has(req.method) || route === '/api/ws') {
      const origin = req.headers.origin;
      const allowedHosts = [req.headers.host, req.headers['x-forwarded-host']]
        .flatMap((h) => (typeof h === 'string' ? h.split(',') : []))
        .map((h) => h.trim().toLowerCase())
        // Origin omits default ports ("http://host"), a Host header may not ("host:80").
        .map((h) => h.replace(/:(80|443)$/, ''))
        .filter(Boolean);
      // Sec-Fetch-Site isn't usable for WebSockets: Chrome reports ws:// as cross-site even
      // for the page's own server (ws vs http scheme). Origin is checked for those instead.
      let crossOrigin = route !== '/api/ws' && req.headers['sec-fetch-site'] === 'cross-site';
      if (origin && origin !== 'null') {
        try {
          crossOrigin ||= !allowedHosts.includes(new URL(origin).host.toLowerCase());
        } catch {
          crossOrigin = true;
        }
      } else if (origin === 'null') crossOrigin = true;
      if (crossOrigin) return reply.status(403).send({ error: 'Cross-site request blocked' });
    }

    if (route && PUBLIC_API.has(route)) return;
    if (!auth.isAuthorized(req)) {
      return reply
        .status(401)
        .send({ error: 'Unauthorized', setupRequired: auth.status(req).setupRequired });
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    // Other sites can't embed or read our responses (e.g. API JSON as a <script>).
    reply.header('cross-origin-resource-policy', 'same-origin');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.startsWith('text/html')) {
      reply.header('content-security-policy', CSP);
      reply.header('x-frame-options', 'DENY');
    }
    return payload;
  });

  // --- WebSocket hub ----------------------------------------------------------

  const clients = new Set<WebSocket>();
  const hub: Hub = {
    broadcast(event) {
      if (clients.size === 0) return;
      const msg = JSON.stringify(event);
      for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(msg);
    },
    get clientCount() {
      return clients.size;
    },
  };
  app.decorate('hub', hub);

  const snapshot = (): ServerEvent =>
    // Dates serialise to ISO strings, matching the wire DTO.
    JSON.parse(JSON.stringify({ type: 'torrents:snapshot', torrents: core.torrents.list() }));

  app.get('/api/ws', { websocket: true }, (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify(snapshot()));
    socket.on('close', () => clients.delete(socket));
  });

  const unsubscribers = [
    core.events.on('torrent:removed', (id) => hub.broadcast({ type: 'torrent:removed', id })),
    core.events.on('torrent:done', (t) =>
      hub.broadcast({ type: 'torrent:done', id: t.id, name: t.name }),
    ),
    core.events.on('torrent:seeded', (t) =>
      hub.broadcast({
        type: 'torrent:seeded',
        id: t.id,
        name: t.name,
        minutes: Math.round(t.seedingTime / 60),
      }),
    ),
    core.events.on('torrent:error', (t) =>
      hub.broadcast({
        type: 'torrent:error',
        id: t.id,
        name: t.name,
        error: t.error ?? 'Unknown error',
      }),
    ),
    core.events.on('rss:updated', (feedId) => hub.broadcast({ type: 'rss:updated', feedId })),
    core.events.on('rss:match', (m) => hub.broadcast({ type: 'rss:match', ...m })),
    core.events.on('stats:tick', (stats) => hub.broadcast({ type: 'stats:tick', stats })),
    core.events.on('upcoming:updated', () => hub.broadcast({ type: 'upcoming:updated' })),
    core.events.on('missing:updated', () => hub.broadcast({ type: 'missing:updated' })),
    core.events.on('sites:updated', () => hub.broadcast({ type: 'sites:updated' })),
    core.events.on('notifications:updated', (e) =>
      hub.broadcast({ type: 'notifications:updated', unread: e.unread, item: e.item }),
    ),
  ];
  const timer = setInterval(() => {
    if (clients.size > 0) hub.broadcast(snapshot());
  }, opts.snapshotIntervalMs ?? 1000);

  app.addHook('onClose', async () => {
    clearInterval(timer);
    unsubscribers.forEach((off) => off());
    for (const ws of clients) ws.close(1001, 'Server shutting down');
  });

  // --- REST -------------------------------------------------------------------

  app.get('/api/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    version: APP_VERSION,
    uptime: Math.round((Date.now() - startedAt) / 1000),
    torrents: core.torrents.list().length,
  }));

  await app.register(authRoutes, { auth });
  await app.register(torrentRoutes, { core });
  await app.register(settingsRoutes, { core, auth, identity: opts.identity });
  await app.register(rssRoutes, { core });
  await app.register(mediaRoutes, { core });
  await app.register(fsRoutes, { core });
  await app.register(siteRoutes, { core });
  await app.register(notificationRoutes, { core });

  app.all('/api/*', async (_req, reply) => reply.status(404).send({ error: 'Not found' }));

  // --- Web UI -----------------------------------------------------------------

  if (opts.webRoot && existsSync(opts.webRoot)) {
    await app.register(fastifyStatic, { root: opts.webRoot });
    // SPA fallback: any non-API GET that isn't a file serves index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: 'Not found' });
    });
  }

  return app;
}
