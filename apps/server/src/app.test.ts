import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createCore, webhookRequest, type BackupBundle, type Core } from '@draxmax/core';
import { FakeEngine, makeTorrentFile } from '@draxmax/core/testing';
import type { ServerEvent, SettingsResponse, TorrentDTO } from '@draxmax/shared';
import { buildServer, redactUrl } from './app.ts';

const MAGNET = 'magnet:?xt=urn:btih:c9e15763f722f23e98a29decdfae341b98d53056&dn=Cosmos';

let dir: string;
let core: Core;
let engine: FakeEngine;
let app: FastifyInstance;

const hooks: { url: string; body: string; headers: Record<string, string> }[] = [];
function boot(env: NodeJS.ProcessEnv = {}): Core {
  engine = new FakeEngine();
  return createCore({
    configPath: join(dir, 'c'),
    downloadPath: join(dir, 'd'),
    engine,
    env,
    webhookSend: async (req) => void hooks.push(req),
  });
}

async function setup(token?: string, env: NodeJS.ProcessEnv = {}, envPassword?: string) {
  dir = mkdtempSync(join(tmpdir(), 'draxmax-server-'));
  hooks.length = 0;
  core = boot(env);
  app = await buildServer({ core, token, snapshotIntervalMs: 20, auth: { envPassword } });
}

const REMOTE = { remoteAddress: '10.1.2.3' };
function cookieOf(res: { cookies: { name: string; value: string }[] }): string {
  const c = res.cookies.find((x) => x.name === 'draxmax_session');
  return c ? `draxmax_session=${c.value}` : '';
}

afterEach(async () => {
  await app.close();
  await core.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('REST API', () => {
  beforeEach(() => setup());

  it('reports health', async () => {
    const res = await app.inject('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', torrents: 0 });
  });

  it('adds, lists, pauses, resumes and removes a magnet', async () => {
    const add = await app.inject({
      method: 'POST',
      url: '/api/torrents/magnet',
      payload: { magnetURI: MAGNET },
    });
    expect(add.statusCode).toBe(201);
    const created = add.json<TorrentDTO>();
    expect(created.status).toBe('metadata');
    expect(typeof created.addedAt).toBe('string');

    const list = await app.inject('/api/torrents');
    expect(list.json<TorrentDTO[]>().map((t) => t.id)).toEqual([created.id]);

    const paused = await app.inject({ method: 'POST', url: `/api/torrents/${created.id}/pause` });
    expect(paused.json<TorrentDTO>().status).toBe('paused');
    const resumed = await app.inject({ method: 'POST', url: `/api/torrents/${created.id}/resume` });
    expect(resumed.json<TorrentDTO>().status).toBe('metadata');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/torrents/${created.id}?deleteFiles=true`,
    });
    expect(del.statusCode).toBe(204);
    expect((await app.inject('/api/torrents')).json()).toEqual([]);
  });

  it('adds a .torrent file sent as base64 and sets file priorities', async () => {
    const data = Buffer.from(
      makeTorrentFile('Pack', [
        { path: ['a.bin'], length: 10 },
        { path: ['b.bin'], length: 10 },
      ]),
    ).toString('base64');
    const add = await app.inject({ method: 'POST', url: '/api/torrents/file', payload: { data } });
    expect(add.statusCode).toBe(201);
    const { id } = add.json<TorrentDTO>();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/torrents/${id}/files`,
      payload: { files: [{ index: 1, priority: 0 }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<TorrentDTO>().files.map((f) => f.selected)).toEqual([true, false]);
  });

  it('maps validation, not-found and conflict errors to status codes', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/torrents/magnet',
      payload: { magnetURI: 'http://x' },
    });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject('/api/torrents/missing')).statusCode).toBe(404);
    await app.inject({
      method: 'POST',
      url: '/api/torrents/magnet',
      payload: { magnetURI: MAGNET },
    });
    const dup = await app.inject({
      method: 'POST',
      url: '/api/torrents/magnet',
      payload: { magnetURI: MAGNET },
    });
    expect(dup.statusCode).toBe(409);
    const badFile = await app.inject({
      method: 'POST',
      url: '/api/torrents/file',
      payload: { data: 'AAAA' },
    });
    expect(badFile.statusCode).toBe(400);
    expect((await app.inject('/api/nope')).statusCode).toBe(404);
  });
});

describe('M2 routes', () => {
  beforeEach(() => setup());

  it('updates torrents, manages trackers, queue and categories', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/torrents/magnet',
        payload: { magnetURI: MAGNET, category: 'Linux' },
      })
    ).json<TorrentDTO>();
    expect(created.category).toBe('Linux');
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/torrents/${created.id}`,
      payload: { tags: ['iso'], sequential: true },
    });
    expect(patched.json<TorrentDTO>()).toMatchObject({ tags: ['iso'], sequentialDownload: true });

    const tr = await app.inject({
      method: 'POST',
      url: `/api/torrents/${created.id}/trackers`,
      payload: { urls: ['udp://t.example:1/announce'] },
    });
    expect(tr.json<TorrentDTO>().trackers.map((t) => t.url)).toEqual([
      'udp://t.example:1/announce',
    ]);
    const off = await app.inject({
      method: 'PATCH',
      url: `/api/torrents/${created.id}/trackers`,
      payload: { url: 'udp://t.example:1/announce', enabled: false },
    });
    expect(off.json<TorrentDTO>().trackers[0]!.status).toBe('disabled');
    const rm = await app.inject({
      method: 'DELETE',
      url: `/api/torrents/${created.id}/trackers`,
      payload: { urls: ['udp://t.example:1/announce'] },
    });
    expect(rm.json<TorrentDTO>().trackers).toEqual([]);

    expect(
      (await app.inject({ method: 'POST', url: `/api/torrents/${created.id}/reannounce` }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/torrents/${created.id}/queue`,
          payload: { move: 'top' },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject(`/api/torrents/${created.id}/peers`)).json()).toEqual([]);

    await app.inject({
      method: 'PUT',
      url: '/api/categories/Movies',
      payload: { savePath: '/tmp/movies' },
    });
    expect((await app.inject('/api/categories')).json()).toEqual([
      { name: 'Linux', savePath: null, seedMinutes: null, seedRatio: null },
      { name: 'Movies', savePath: '/tmp/movies', seedMinutes: null, seedRatio: null },
    ]);
    expect((await app.inject('/api/tags')).json()).toEqual(['iso']);
  });

  it('reads and patches settings, hiding secrets', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { tmdbApiKey: 'k3y', maxActiveDownloads: 3 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.settings.tmdbApiKey).toBe('');
    expect(body.secretsSet.tmdbApiKey).toBe(true);
    expect(body.settings.maxActiveDownloads).toBe(3);
    expect(body.settings.webuiPasswordHash).toBeUndefined();
    expect(core.settings.get().tmdbApiKey).toBe('k3y');
    // The key is encrypted at rest.
    const raw = (await import('node:fs')).readFileSync(join(dir, 'c', 'settings.json'), 'utf8');
    expect(raw).not.toContain('k3y');

    expect(
      (await app.inject({ method: 'PATCH', url: '/api/settings', payload: { nope: 1 } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'PATCH', url: '/api/settings', payload: { torrentPort: 'x' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/settings',
          payload: { webuiPasswordHash: 'x' },
        })
      ).statusCode,
    ).toBe(400);
    const cleared = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { tmdbApiKey: null },
    });
    expect(cleared.json().secretsSet.tmdbApiKey).toBe(false);
  });
});

describe('run as user/group', () => {
  beforeEach(() => setup());
  afterEach(() => {
    delete process.env.ACCOUNTS_DIR;
  });

  it('resolves names to ids, validates them and reports the current account', async () => {
    const etc = join(dir, 'etc');
    mkdirSync(etc);
    writeFileSync(
      join(etc, 'passwd'),
      'root:x:0:0:root:/root:/bin/sh\noldmagic:x:1000:1000::/home/oldmagic:/bin/bash\n',
    );
    writeFileSync(join(etc, 'group'), 'root:x:0:\noldmagic:x:1000:\nmedia:x:1500:oldmagic\n');
    process.env.ACCOUNTS_DIR = etc;
    const patch = (payload: object) =>
      app.inject({ method: 'PATCH', url: '/api/settings', payload });

    const ok = await patch({ runAsUser: 'oldmagic', runAsGroup: '' });
    expect(ok.statusCode).toBe(200);
    const body = ok.json<SettingsResponse>();
    expect(body.settings).toMatchObject({ runAsUser: 'oldmagic', runAsGroup: '' });
    expect(core.settings.get()).toMatchObject({ runAsUid: 1000, runAsGid: 1000 });
    expect(body.identity).toMatchObject({
      uid: process.getuid!(),
      canApply: false,
      canRestart: false,
    });

    await patch({ runAsGroup: 'media' });
    expect(core.settings.get()).toMatchObject({ runAsUid: 1000, runAsGid: 1500 });
    await patch({ runAsUser: '1234', runAsGroup: '' });
    expect(core.settings.get()).toMatchObject({ runAsUid: 1234, runAsGid: 1234 });

    expect((await patch({ runAsUser: 'nobody-here' })).json().error).toMatch(/Unknown user/);
    expect((await patch({ runAsUser: 'bad name!' })).statusCode).toBe(400);
    // Resolved ids are internal.
    expect((await patch({ runAsUid: 0 })).statusCode).toBe(400);

    await patch({ runAsUser: '', runAsGroup: '' });
    expect(core.settings.get().runAsUid).toBeUndefined();
    expect((await app.inject({ method: 'POST', url: '/api/system/restart' })).statusCode).toBe(400);
  });
});

describe('folder browser', () => {
  beforeEach(() => setup());

  it('lists, creates and validates folders', async () => {
    const def = await app.inject('/api/fs/dirs');
    expect(def.json()).toMatchObject({
      path: join(dir, 'd'),
      parent: dir,
      dirs: [],
      writable: true,
    });
    expect(typeof def.json().freeBytes).toBe('number');

    const made = await app.inject({
      method: 'POST',
      url: '/api/fs/dirs',
      payload: { path: join(dir, 'd', 'Anime', 'S01') },
    });
    expect(made.statusCode).toBe(201);
    const list = await app.inject(`/api/fs/dirs?path=${encodeURIComponent(join(dir, 'd'))}`);
    expect(list.json().dirs).toEqual(['Anime']);

    expect((await app.inject('/api/fs/dirs?path=relative')).statusCode).toBe(400);
    expect((await app.inject(`/api/fs/dirs?path=${join(dir, 'nope')}`)).statusCode).toBe(404);
    const rel = await app.inject({
      method: 'POST',
      url: '/api/torrents/magnet',
      payload: { magnetURI: MAGNET, savePath: 'downloads' },
    });
    expect(rel.statusCode).toBe(400);
    const abs = await app.inject({
      method: 'POST',
      url: '/api/torrents/magnet',
      payload: { magnetURI: MAGNET, savePath: join(dir, 'nas') },
    });
    expect(abs.json<TorrentDTO>().savePath).toBe(join(dir, 'nas'));
  });
});

describe('Web UI auth', () => {
  it('trusts loopback but requires remote clients to create a login first', async () => {
    await setup();
    expect((await app.inject('/api/torrents')).statusCode).toBe(200);
    const remote = await app.inject({ url: '/api/torrents', ...REMOTE });
    expect(remote.statusCode).toBe(401);
    expect(remote.json().setupRequired).toBe(true);
    // A local reverse proxy forwarding a remote user is not trusted.
    expect(
      (await app.inject({ url: '/api/torrents', headers: { 'x-forwarded-for': '8.8.8.8' } }))
        .statusCode,
    ).toBe(401);

    const weak = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'me', password: 'short' },
      ...REMOTE,
    });
    expect(weak.statusCode).toBe(400);
    // Remote setup needs the one-time code from the server log.
    expect(remote.json()).toMatchObject({ setupRequired: true });
    const noCode = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'me', password: 'correct horse' },
      ...REMOTE,
    });
    expect(noCode.statusCode).toBe(403);
    expect(noCode.json().setupCodeRequired).toBe(true);
    const wrongCode = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'me', password: 'correct horse', setupCode: 'NOPE' },
      ...REMOTE,
    });
    expect(wrongCode.statusCode).toBe(403);
    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'me', password: 'correct horse', setupCode: app.auth.setupCode },
      ...REMOTE,
    });
    expect(setupRes.statusCode).toBe(200);
    const cookie = cookieOf(setupRes);
    expect(cookie).not.toBe('');
    expect(
      (await app.inject({ url: '/api/torrents', headers: { cookie }, ...REMOTE })).statusCode,
    ).toBe(200);
    // Once configured, loopback needs a session too, and setup can't be repeated.
    expect((await app.inject('/api/torrents')).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/setup',
          payload: { username: 'x', password: 'whatever1' },
        })
      ).statusCode,
    ).toBe(409);
  });

  it('logs in, rate-limits failures and logs out', async () => {
    await setup(undefined, { WEBUI_USERNAME: 'admin' }, 'hunter22!');
    expect((await app.inject('/api/auth/status')).json()).toMatchObject({
      configured: true,
      managedByEnv: true,
      authenticated: false,
    });
    for (let i = 0; i < 5; i++) {
      const bad = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'nope' },
      });
      expect(bad.statusCode).toBe(401);
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'hunter22!' },
    });
    expect(limited.statusCode).toBe(429);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'hunter22!' },
      remoteAddress: '10.9.9.9',
    });
    expect(ok.statusCode).toBe(200);
    const cookie = cookieOf(ok);
    expect((await app.inject({ url: '/api/torrents', headers: { cookie } })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect((await app.inject({ url: '/api/torrents', headers: { cookie } })).statusCode).toBe(401);
    // Env-managed credentials can't be changed through the API.
    const change = await app.inject({
      method: 'PUT',
      url: '/api/auth/credentials',
      payload: { username: 'a', password: 'longenough' },
      headers: { cookie: cookieOf(ok) },
    });
    expect(change.statusCode).not.toBe(200);
  });
});

describe('token auth', () => {
  beforeEach(() => setup('s3cret'));

  it('pushes the torrent list over WebSocket, then only what changed', async () => {
    await app.ready();
    const auth = { authorization: 'Bearer s3cret' };
    const add = await app.inject({
      method: 'POST',
      url: '/api/torrents/magnet',
      headers: auth,
      payload: { magnetURI: MAGNET },
    });
    const id = add.json<TorrentDTO>().id;
    const events: ServerEvent[] = [];
    const ws = await app.injectWS(
      '/api/ws?token=s3cret',
      {},
      {
        onInit: (s) =>
          s.on('message', (m: Buffer) => events.push(JSON.parse(m.toString()) as ServerEvent)),
      },
    );
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(ok()).toBe(true);
    };
    await until(() => events.length > 0);
    const first = events[0]!;
    expect(first.type).toBe('torrents:snapshot');
    if (first.type === 'torrents:snapshot') expect(first.torrents).toHaveLength(1);

    // Nothing changes: after the first tick settles, no more torrent messages arrive.
    await new Promise((r) => setTimeout(r, 80));
    const settled = events.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(events.length).toBe(settled);

    await app.inject({ method: 'POST', url: `/api/torrents/${id}/pause`, headers: auth });
    await until(() =>
      events.some((e) => e.type === 'torrents:delta' && e.changed[0]?.status === 'paused'),
    );
    await app.inject({ method: 'DELETE', url: `/api/torrents/${id}`, headers: auth });
    await until(() => events.some((e) => e.type === 'torrents:delta' && e.order?.length === 0));
    ws.terminate();
  });

  it('ends live feeds when their session ends, but not token ones', async () => {
    await app.ready();
    const auth = { authorization: 'Bearer s3cret' };
    await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: auth,
      payload: { username: 'admin', password: 'correct horse' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'correct horse' },
      ...REMOTE,
    });
    const cookie = cookieOf(login);
    const closed = (ws: { once(e: 'close', fn: (code: number) => void): void }) =>
      new Promise<number>((resolve) => ws.once('close', resolve));
    const session = await app.injectWS('/api/ws', { headers: { cookie } });
    const token = await app.injectWS('/api/ws?token=s3cret');
    const code = closed(session);
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(await code).toBe(4401);
    expect(token.readyState).toBe(token.OPEN);
    token.terminate();
  });

  it('keeps sessions across a restart, and drops them when the login changes', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      headers: { authorization: 'Bearer s3cret' },
      payload: { username: 'admin', password: 'correct horse' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'correct horse' },
      ...REMOTE,
    });
    const cookie = cookieOf(login);
    const ok = async () =>
      (await app.inject({ url: '/api/torrents', headers: { cookie }, ...REMOTE })).statusCode;
    expect(await ok()).toBe(200);
    // The cookie value itself is never stored.
    const rows = core.db.prepare('SELECT id_hash FROM sessions').all() as { id_hash: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(cookie).not.toContain(r.id_hash);
    expect(JSON.stringify(rows)).not.toContain(cookie.split('=')[1]!);

    await app.close();
    app = await buildServer({ core, token: 's3cret' });
    expect(await ok()).toBe(200);

    await app.close();
    core.settings.update({ webuiUsername: 'someone-else' });
    app = await buildServer({ core, token: 's3cret' });
    expect(await ok()).toBe(401);
  });

  it('closes the socket of a rejected WebSocket upgrade', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const socket = connect(port, '127.0.0.1');
    let response = '';
    socket.on('data', (d: Buffer) => (response += d.toString()));
    socket.write(
      'GET /api/ws HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: 10.1.2.3\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
        'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    );
    // Before the fix the server answered 401 but never closed the connection.
    await new Promise((resolve) => socket.on('close', resolve));
    expect(response).toMatch(/^HTTP\/1\.1 401/);
  });

  it('accepts the token as a header from anywhere; health is public but says nothing', async () => {
    const health = await app.inject({ url: '/api/health', ...REMOTE });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });
    expect((await app.inject({ url: '/api/torrents', ...REMOTE })).statusCode).toBe(401);
    // In a URL the token would end up in logs and history: only the WebSocket takes it there.
    expect((await app.inject({ url: '/api/torrents?token=s3cret', ...REMOTE })).statusCode).toBe(
      401,
    );
    const bearer = (t: string) =>
      app.inject({ url: '/api/torrents', headers: { authorization: `Bearer ${t}` }, ...REMOTE });
    expect((await bearer('nope!!')).statusCode).toBe(401);
    expect((await bearer('s3cret')).statusCode).toBe(200);
  });
});

describe('security', () => {
  beforeEach(() => setup());

  it('requires auth however the API path is spelled', async () => {
    for (const url of [
      '/%61pi/settings',
      '/a%70i/fs/dirs?path=/etc',
      '/API/torrents',
      '//api/torrents',
      '/api/torrents/',
      '/%2561pi/torrents',
    ]) {
      const res = await app.inject({ url, ...REMOTE });
      expect([401, 404], url).toContain(res.statusCode);
      expect(res.body, url).not.toMatch(/downloadPath|"dirs"/);
    }
    const post = await app.inject({ method: 'POST', url: '/%61pi/torrents/pause-all', ...REMOTE });
    expect(post.statusCode).toBe(401);
  });

  it('blocks cross-site requests and DNS rebinding against the trusted local machine', async () => {
    // A page on another site POSTing to the local instance (CSRF).
    for (const headers of [
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { 'sec-fetch-site': 'cross-site' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/torrents/pause-all', headers });
      expect(res.statusCode, JSON.stringify(headers)).toBe(403);
    }
    // Same-origin requests from the Web UI still work.
    const same = await app.inject({
      method: 'POST',
      url: '/api/torrents/pause-all',
      headers: { host: '127.0.0.1:8895', origin: 'http://127.0.0.1:8895' },
    });
    expect(same.statusCode).toBe(204);
    // A rebinding domain resolving to 127.0.0.1 isn't "this machine".
    const rebound = await app.inject({
      url: '/api/settings',
      headers: { host: 'evil.example:8895' },
    });
    expect(rebound.statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/api/settings', headers: { host: 'localhost:8895' } })).statusCode,
    ).toBe(200);
    // Cross-site WebSocket handshakes are refused too.
    const ws = await app.inject({
      url: '/api/ws',
      headers: { origin: 'https://evil.example', connection: 'upgrade', upgrade: 'websocket' },
    });
    expect(ws.statusCode).toBe(403);
  });

  it('keeps tokens out of logged URLs and sends hardening headers', async () => {
    expect(redactUrl('/api/ws?token=abc&x=1')).toBe('/api/ws?token=[redacted]&x=1');
    expect(redactUrl('/x?apikey=k&passkey=p')).toBe('/x?apikey=[redacted]&passkey=[redacted]');
    const res = await app.inject('/api/health');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('needs the current password to change the login, and removes it only locally', async () => {
    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'me', password: 'correct horse' },
    });
    const cookie = cookieOf(setupRes);
    const change = (currentPassword?: string) =>
      app.inject({
        method: 'PUT',
        url: '/api/auth/credentials',
        payload: { username: 'me', password: 'battery staple', currentPassword },
        headers: { cookie },
        ...REMOTE,
      });
    expect((await change()).statusCode).toBe(403);
    expect((await change('wrong password')).statusCode).toBe(403);
    const ok = await change('correct horse');
    expect(ok.statusCode).toBe(200);
    const removeRemote = await app.inject({
      method: 'DELETE',
      url: '/api/auth/credentials',
      headers: { cookie: cookieOf(ok) },
      ...REMOTE,
    });
    expect(removeRemote.statusCode).toBe(403);
  });

  it('serves sites without ever returning their credentials', async () => {
    expect((await app.inject({ url: '/api/sites', ...REMOTE })).statusCode).toBe(401);
    const created = await app.inject({
      method: 'POST',
      url: '/api/sites',
      payload: {
        name: 'SuperBits',
        baseUrls: ['https://superbits.org/'],
        searchUrls: ['/search?search={query}'],
        infoUrl: '/torrent/{id}/',
        downloadUrl: '/download.php?id={id}&passkey={passkey}',
        fields: [{ name: 'passkey', label: 'Passkey' }],
        values: { passkey: 'TOPSECRETKEY' },
        cookies: 'sbid=COOKIEVALUE',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toMatch(/TOPSECRETKEY|COOKIEVALUE/);
    const list = await app.inject('/api/sites');
    expect(list.json()[0].secretsSet).toEqual({
      values: { passkey: true },
      cookies: 1,
      headers: 0,
    });
    expect(list.body).not.toMatch(/TOPSECRETKEY|COOKIEVALUE/);
    const presets = (await app.inject('/api/sites/presets')).json() as { id: string }[];
    expect(presets.some((p) => p.id === 'superbits')).toBe(true);
  });

  it('records security events and serves the notification history', async () => {
    expect((await app.inject({ url: '/api/notifications', ...REMOTE })).statusCode).toBe(401);
    await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'me', password: 'correct horse' },
    });
    for (let i = 0; i < 3; i++)
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'me', password: 'wrong password' },
        ...REMOTE,
      });
    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'me', password: 'correct horse' },
      ...REMOTE,
    });
    // The login response itself says "signed in", so the UI can leave the login screen.
    expect(ok.json()).toMatchObject({ authenticated: true });
    const cookie = cookieOf(ok);
    const list = await app.inject({
      url: '/api/notifications?category=security',
      headers: { cookie },
      ...REMOTE,
    });
    const items = list.json().items as { title: string; count: number; id: number }[];
    expect(items.map((i) => i.title)).toEqual([
      'Signed in from 10.1.2.3',
      'Failed login for “me” from 10.1.2.3',
      'Web UI login created',
    ]);
    expect(items[1]!.count).toBe(3);
    expect(list.body).not.toMatch(/wrong password|correct horse/);

    const read = await app.inject({
      method: 'POST',
      url: '/api/notifications/read',
      payload: { all: true, read: true },
      headers: { cookie, origin: 'http://localhost:80', host: 'localhost:80' },
      ...REMOTE,
    });
    expect(read.json().unread).toBe(0);
    const count = await app.inject({
      url: '/api/notifications/count',
      headers: { cookie },
      ...REMOTE,
    });
    expect(count.json()).toEqual({ unread: 0 });
  });
});

describe('qBittorrent-compatible API', () => {
  beforeEach(() => setup());
  const form = (data: Record<string, string>) => ({
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(data).toString(),
  });

  it('lets a download manager add, watch, pause and delete torrents', async () => {
    expect((await app.inject('/api/v2/app/webapiVersion')).body).toBe('2.9.3');
    await app.inject({
      method: 'POST',
      url: '/api/v2/torrents/createCategory',
      ...form({ category: 'tv-sonarr', savePath: '/data/tv' }),
    });
    expect((await app.inject('/api/v2/torrents/categories')).json()).toEqual({
      'tv-sonarr': { name: 'tv-sonarr', savePath: '/data/tv' },
    });

    // Sonarr sends .torrent files as multipart, magnets in `urls`.
    const boundary = 'XBOUNDARYX';
    const file = Buffer.from(makeTorrentFile('Show.S01E01', [{ path: ['ep.mkv'], length: 100 }]));
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="category"\r\n\r\ntv-sonarr\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="paused"\r\n\r\nfalse\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="torrents"; filename="a.torrent"\r\nContent-Type: application/x-bittorrent\r\n\r\n`,
      ),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const add = await app.inject({
      method: 'POST',
      url: '/api/v2/torrents/add',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart,
    });
    expect(add.body).toBe('Ok.');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v2/torrents/add',
          ...form({ urls: MAGNET, category: 'tv-sonarr' }),
        })
      ).body,
    ).toBe('Ok.');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v2/torrents/add',
          ...form({ urls: 'magnet:?dn=broken' }),
        })
      ).body,
    ).toBe('Fails.');

    const list = (await app.inject('/api/v2/torrents/info?category=tv-sonarr')).json<
      Record<string, unknown>[]
    >();
    expect(list).toHaveLength(2);
    const show = list.find((x) => x.name === 'Show.S01E01')!;
    expect(show).toMatchObject({
      save_path: '/data/tv',
      content_path: '/data/tv/Show.S01E01',
      category: 'tv-sonarr',
      progress: 0,
    });
    const hash = show.hash as string;
    expect((await app.inject(`/api/v2/torrents/files?hash=${hash}`)).json()).toMatchObject([
      { name: 'Show.S01E01/ep.mkv' },
    ]);
    expect((await app.inject(`/api/v2/torrents/properties?hash=${hash}`)).json()).toMatchObject({
      save_path: '/data/tv',
    });

    await app.inject({ method: 'POST', url: '/api/v2/torrents/pause', ...form({ hashes: hash }) });
    expect((await app.inject(`/api/v2/torrents/info?hashes=${hash}`)).json()).toMatchObject([
      { state: 'pausedDL' },
    ]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v2/torrents/setShareLimits',
          ...form({ hashes: hash, ratioLimit: '1' }),
        })
      ).body,
    ).toBe('Ok.');
    await app.inject({
      method: 'POST',
      url: '/api/v2/torrents/delete',
      ...form({ hashes: hash, deleteFiles: 'true' }),
    });
    expect((await app.inject('/api/v2/torrents/info')).json()).toHaveLength(1);
  });

  it('logs in with the Web UI login and an SID cookie', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'correct horse' },
    });
    expect((await app.inject({ url: '/api/v2/torrents/info', ...REMOTE })).statusCode).toBe(401);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      ...form({ username: 'admin', password: 'nope' }),
      ...REMOTE,
    });
    expect(bad.body).toBe('Fails.');
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      ...form({ username: 'admin', password: 'correct horse' }),
      ...REMOTE,
    });
    expect(ok.body).toBe('Ok.');
    const sid = ok.cookies.find((c) => c.name === 'SID')!;
    expect(sid.httpOnly).toBe(true);
    const authed = await app.inject({
      url: '/api/v2/torrents/info',
      headers: { cookie: `SID=${sid.value}` },
      ...REMOTE,
    });
    expect(authed.statusCode).toBe(200);
    // Another site still can't drive it.
    const csrf = await app.inject({
      method: 'POST',
      url: '/api/v2/torrents/delete',
      headers: {
        cookie: `SID=${sid.value}`,
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'hashes=all',
    });
    expect(csrf.statusCode).toBe(403);
  });
});

describe('backup, locations and outside notifications', () => {
  beforeEach(() => setup());

  it('backs up everything and restores it on the next start', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/torrents/magnet',
      payload: { magnetURI: MAGNET },
    });
    core.settings.update({ tmdbApiKey: 'tmdb-secret', maxActiveDownloads: 9 });
    const res = await app.inject('/api/backup');
    expect(res.headers['content-disposition']).toMatch(/draxmax-backup-.*\.json/);
    const bundle = res.json<BackupBundle>();
    expect(Object.keys(bundle.files).sort()).toEqual(['draxmax.db', 'secret.key', 'settings.json']);
    expect(res.body).not.toContain('tmdb-secret');

    // Things change, then the backup is restored.
    await core.torrents.remove(core.torrents.list()[0]!.id, false);
    core.settings.update({ maxActiveDownloads: 2 });
    expect(
      (await app.inject({ method: 'POST', url: '/api/backup/restore', payload: { app: 'other' } }))
        .statusCode,
    ).toBe(400);
    const restore = await app.inject({
      method: 'POST',
      url: '/api/backup/restore',
      payload: bundle,
    });
    expect(restore.statusCode).toBe(202);
    expect(core.torrents.list()).toHaveLength(0);

    await app.close();
    await core.shutdown();
    core = boot();
    app = await buildServer({ core });
    expect(core.torrents.list().map((t) => t.name)).toEqual(['Cosmos']);
    expect(core.settings.get()).toMatchObject({ maxActiveDownloads: 9, tmdbApiKey: 'tmdb-secret' });
    expect(existsSync(join(dir, 'c', 'before-restore', 'draxmax.db'))).toBe(true);
    expect(existsSync(join(dir, 'c', 'restore'))).toBe(false);
  });

  it('needs the current password for a backup once a login exists', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'admin', password: 'correct horse' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'correct horse' },
    });
    const cookie = cookieOf(login);
    expect((await app.inject({ url: '/api/backup', headers: { cookie } })).statusCode).toBe(403);
    const ok = await app.inject({
      url: '/api/backup',
      headers: { cookie, 'x-confirm-password': 'correct horse' },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("changes a torrent's folder through the API", async () => {
    const add = await app.inject({
      method: 'POST',
      url: '/api/torrents/magnet',
      payload: { magnetURI: MAGNET },
    });
    const id = add.json<TorrentDTO>().id;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/torrents/${id}/location`,
          payload: { savePath: 'relative' },
        })
      ).statusCode,
    ).toBe(400);
    const moved = await app.inject({
      method: 'POST',
      url: `/api/torrents/${id}/location`,
      payload: { savePath: join(dir, 'elsewhere') },
    });
    expect(moved.json<TorrentDTO>().savePath).toBe(join(dir, 'elsewhere'));
  });

  it('sends finished downloads to the webhook in the shape each service reads', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/notifications/test' })).statusCode).toBe(
      400,
    );
    await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { notifyWebhookUrl: 'https://ntfy.sh/my-topic' },
    });
    // The URL is a secret: stored encrypted and never returned.
    const settings = (await app.inject('/api/settings')).json<SettingsResponse>();
    expect(settings.settings.notifyWebhookUrl).toBe('');
    expect(settings.secretsSet.notifyWebhookUrl).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/notifications/test' })).statusCode).toBe(
      200,
    );
    expect(hooks.at(-1)).toMatchObject({
      url: 'https://ntfy.sh/my-topic',
      body: 'Notifications from DraxMax will arrive here.',
    });

    core.events.emit('torrent:done', { name: 'Some.Show.S01E01' } as never);
    await new Promise((r) => setTimeout(r, 10));
    expect(hooks.at(-1)!.body).toBe('Some.Show.S01E01');
    core.settings.update({ notifyOnComplete: false });
    const n = hooks.length;
    core.events.emit('torrent:done', { name: 'Quiet' } as never);
    await new Promise((r) => setTimeout(r, 10));
    expect(hooks).toHaveLength(n);

    const discord = webhookRequest(
      'https://discord.com/api/webhooks/1/abc',
      'Download complete',
      'X',
    );
    expect(JSON.parse(discord.body)).toMatchObject({
      content: 'Download complete\nX',
      text: 'Download complete\nX',
      title: 'Download complete',
      message: 'X',
    });
  });
});
