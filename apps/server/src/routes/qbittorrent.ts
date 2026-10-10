import { posix } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CoreError, fetchBytes, type Core } from '@draxmax/core';
import { isAbsolutePath, MAGNET_RE, type TorrentItem } from '@draxmax/shared';
import type { AuthService } from '../auth.ts';

/** Cookie name qBittorrent clients expect; it carries an ordinary DraxMax session. */
export const QB_COOKIE = 'SID';

type Form = Record<string, string>;
interface Upload {
  fields: Form;
  files: Buffer[];
}

/** Splits a multipart/form-data body into text fields and uploaded files. */
export function parseMultipart(body: Buffer, contentType: string): Upload {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const out: Upload = { fields: {}, files: [] };
  if (!m) return out;
  const delimiter = Buffer.from(`--${m[1] ?? m[2]}`);
  let at = body.indexOf(delimiter);
  while (at !== -1) {
    const start = at + delimiter.length;
    const next = body.indexOf(delimiter, start);
    if (next === -1) break;
    // Part = CRLF headers CRLF CRLF content CRLF.
    const part = body.subarray(start, next);
    const split = part.indexOf('\r\n\r\n');
    if (split !== -1) {
      const head = part.subarray(0, split).toString('utf8');
      const content = part.subarray(split + 4, part.length - 2);
      const name = /name="([^"]*)"/i.exec(head)?.[1];
      if (/filename="/i.test(head)) out.files.push(Buffer.from(content));
      else if (name) out.fields[name] = content.toString('utf8');
    }
    at = next;
  }
  return out;
}

const STATE: Record<TorrentItem['status'], (done: boolean) => string> = {
  downloading: () => 'downloading',
  seeding: () => 'uploading',
  paused: (done) => (done ? 'pausedUP' : 'pausedDL'),
  queued: (done) => (done ? 'queuedUP' : 'queuedDL'),
  error: () => 'error',
  checking: (done) => (done ? 'checkingUP' : 'checkingDL'),
  metadata: () => 'metaDL',
  moving: () => 'moving',
};

const unix = (d: Date | undefined) => (d ? Math.floor(d.getTime() / 1000) : -1);

/** Where the torrent's content is: its top folder, or the file itself for single files. */
function contentPath(t: TorrentItem): string {
  const first = t.files[0]?.path;
  if (!first) return posix.join(t.savePath, t.name);
  const top = first.split('/')[0]!;
  return posix.join(t.savePath, t.files.length > 1 || first.includes('/') ? top : first);
}

function info(t: TorrentItem) {
  const done = t.completedAt !== undefined;
  const wanted = t.files.filter((f) => f.selected).reduce((s, f) => s + f.size, 0) || t.totalSize;
  return {
    hash: t.infoHash,
    infohash_v1: t.infoHash,
    name: t.name,
    magnet_uri: t.magnetURI ?? `magnet:?xt=urn:btih:${t.infoHash}`,
    size: wanted,
    total_size: t.totalSize,
    progress: t.progress,
    dlspeed: t.downloadSpeed,
    upspeed: t.uploadSpeed,
    priority: t.priority + 1,
    num_seeds: t.seeds,
    num_leechs: Math.max(0, t.peers - t.seeds),
    ratio: t.ratio,
    // qBittorrent reports 8640000 for "unknown".
    eta: t.eta ?? 8_640_000,
    state: STATE[t.status](done),
    seq_dl: t.sequentialDownload,
    category: t.category ?? '',
    tags: t.tags.join(', '),
    save_path: t.savePath,
    content_path: contentPath(t),
    added_on: unix(t.addedAt),
    completion_on: unix(t.completedAt),
    amount_left: Math.max(0, Math.round(wanted * (1 - t.progress))),
    completed: Math.round(wanted * t.progress),
    downloaded: t.downloaded,
    uploaded: t.uploaded,
    seeding_time: t.seedingTime,
    ratio_limit: -2,
    seeding_time_limit: -2,
    last_activity: Math.floor(Date.now() / 1000),
    tracker: t.trackers[0]?.url ?? '',
    force_start: false,
    auto_tmm: false,
    private: t.private === true,
  };
}

/**
 * The part of qBittorrent's Web API (v2) that Sonarr, Radarr, Lidarr, Prowlarr and similar
 * tools use to hand over downloads and watch them finish. Add DraxMax to them as a
 * "qBittorrent" download client with the Web UI login (or no login from the same machine).
 */
export async function qbittorrentRoutes(
  app: FastifyInstance,
  { core, auth }: { core: Core; auth: AuthService },
): Promise<void> {
  // These clients post forms, not JSON. Registered here only: the plugin is encapsulated.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer' }, (req, body, done) =>
    done(null, parseMultipart(body as Buffer, req.headers['content-type'] ?? '')),
  );

  const t = core.torrents;
  const text = (reply: FastifyReply, body = 'Ok.') => reply.type('text/plain').send(body);
  const params = (req: FastifyRequest): Form => ({
    ...(req.query as Form),
    ...(((req.body as Upload | Form | undefined) && 'fields' in (req.body as object)
      ? (req.body as Upload).fields
      : (req.body as Form | undefined)) ?? {}),
  });
  /** Torrents named by a `hashes` parameter ("a|b|c" or "all"). */
  const selected = (hashes: string | undefined): TorrentItem[] => {
    const all = t.list();
    if (!hashes || hashes === 'all') return hashes === 'all' ? all : [];
    const wanted = new Set(hashes.toLowerCase().split('|'));
    return all.filter((x) => wanted.has(x.infoHash));
  };
  const one = (hash: string | undefined): TorrentItem => {
    const found = selected(hash)[0];
    if (!found) throw new CoreError('not_found', 'Torrent not found');
    return found;
  };

  app.post('/api/v2/auth/login', async (req, reply) => {
    const { username = '', password = '' } = params(req);
    // No login configured: this machine is trusted, exactly as in the Web UI.
    if (!auth.configured()) return text(reply, auth.isAuthorized(req) ? 'Ok.' : 'Fails.');
    const sid = auth.login(req, username, password);
    if (sid === 'rate_limited') return reply.status(403).type('text/plain').send('Fails.');
    if (!sid) return text(reply, 'Fails.');
    reply.setCookie(QB_COOKIE, sid, { path: '/', httpOnly: true, sameSite: 'strict' });
    return text(reply);
  });
  app.post('/api/v2/auth/logout', async (req, reply) => {
    auth.logout(req);
    reply.clearCookie(QB_COOKIE, { path: '/' });
    return text(reply);
  });

  app.get('/api/v2/app/version', async (_req, reply) => text(reply, 'v4.6.7'));
  app.get('/api/v2/app/webapiVersion', async (_req, reply) => text(reply, '2.9.3'));
  app.get('/api/v2/app/buildInfo', async () => ({ bitness: 64, platform: process.platform }));
  app.get('/api/v2/app/preferences', async () => {
    const s = core.settings.get();
    return {
      save_path: s.downloadPath,
      temp_path_enabled: s.incompletePath !== '',
      temp_path: s.incompletePath,
      max_ratio_enabled: s.seedRatioLimit > 0,
      max_ratio: s.seedRatioLimit > 0 ? s.seedRatioLimit : -1,
      max_seeding_time_enabled: s.seedTimeLimitMinutes > 0,
      max_seeding_time: s.seedTimeLimitMinutes > 0 ? s.seedTimeLimitMinutes : -1,
      // 0 = stop the torrent, 1 = remove it.
      max_ratio_act: s.seedLimitAction === 'remove' ? 1 : 0,
      queueing_enabled: s.maxActiveDownloads > 0,
      max_active_downloads: s.maxActiveDownloads,
      dht: s.dht,
      listen_port: s.torrentPort,
      dl_limit: Math.max(0, s.downloadLimit),
      up_limit: Math.max(0, s.uploadLimit),
    };
  });
  app.get('/api/v2/transfer/info', async () => ({
    dl_info_speed: core.engine.downloadSpeed,
    up_info_speed: core.engine.uploadSpeed,
    dl_info_data: core.engine.sessionTotals().downloaded,
    up_info_data: core.engine.sessionTotals().uploaded,
    dht_nodes: core.engine.dhtNodes(),
    connection_status: 'connected',
  }));

  app.get('/api/v2/torrents/info', async (req) => {
    const q = params(req);
    let list = q.hashes ? selected(q.hashes) : t.list();
    if (q.category !== undefined) list = list.filter((x) => (x.category ?? '') === q.category);
    if (q.tag !== undefined)
      list = list.filter((x) => (q.tag ? x.tags.includes(q.tag) : !x.tags.length));
    return list.map(info);
  });
  app.get('/api/v2/torrents/properties', async (req) => {
    const x = one(params(req).hash);
    return {
      hash: x.infoHash,
      save_path: x.savePath,
      seeding_time: x.seedingTime,
      share_ratio: x.ratio,
      total_size: x.totalSize,
      addition_date: unix(x.addedAt),
      completion_date: unix(x.completedAt),
      eta: x.eta ?? 8_640_000,
      peers: x.peers,
      seeds: x.seeds,
    };
  });
  app.get('/api/v2/torrents/files', async (req) =>
    one(params(req).hash).files.map((f, index) => ({
      index,
      name: f.path,
      size: f.size,
      progress: f.progress,
      priority: f.priority,
    })),
  );

  app.post('/api/v2/torrents/add', async (req, reply) => {
    const body = req.body as Upload | Form | undefined;
    const fields = params(req);
    const files = body && 'files' in body ? (body as Upload).files : [];
    const savePath = fields.savepath?.trim();
    if (savePath && !isAbsolutePath(savePath))
      throw new CoreError('invalid_input', 'savepath must be an absolute path');
    const opts = {
      origin: 'api' as const,
      originDetail: 'qBittorrent API',
      ...(savePath ? { savePath } : {}),
      ...(fields.category ? { category: fields.category } : {}),
      ...(fields.tags ? { tags: fields.tags.split(',').map((x) => x.trim()) } : {}),
      paused: fields.paused === 'true' || fields.stopped === 'true',
      sequential: fields.sequentialDownload === 'true',
    };
    let accepted = 0;
    const add = async (fn: () => unknown) => {
      try {
        await fn();
        accepted++;
      } catch (err) {
        // Already in the list is what the caller wanted.
        if (err instanceof CoreError && err.code === 'conflict') accepted++;
        else req.log.warn(`qBittorrent API add failed: ${(err as Error).message}`);
      }
    };
    for (const url of (fields.urls ?? '')
      .split(/\r?\n/)
      .map((u) => u.trim())
      .filter(Boolean)) {
      if (MAGNET_RE.test(url)) await add(() => t.addMagnet(url, opts));
      else
        await add(async () => {
          // Links come from the *arr app's own indexers, usually Prowlarr on the LAN.
          const { body: data } = await fetchBytes(url, {
            maxBytes: 16 * 1024 * 1024,
            headers: { accept: 'application/x-bittorrent, */*' },
          });
          await t.addTorrentFile(data, opts);
        });
    }
    for (const file of files) await add(() => t.addTorrentFile(file, opts));
    return text(reply, accepted > 0 ? 'Ok.' : 'Fails.');
  });

  app.post('/api/v2/torrents/delete', async (req, reply) => {
    const q = params(req);
    for (const x of selected(q.hashes)) await t.remove(x.id, q.deleteFiles === 'true');
    return text(reply);
  });
  for (const path of ['pause', 'stop'])
    app.post(`/api/v2/torrents/${path}`, async (req, reply) => {
      for (const x of selected(params(req).hashes)) await t.pause(x.id);
      return text(reply);
    });
  for (const path of ['resume', 'start'])
    app.post(`/api/v2/torrents/${path}`, async (req, reply) => {
      for (const x of selected(params(req).hashes)) t.resume(x.id);
      return text(reply);
    });
  app.post('/api/v2/torrents/recheck', async (req, reply) => {
    for (const x of selected(params(req).hashes)) await t.recheck(x.id);
    return text(reply);
  });
  app.post('/api/v2/torrents/reannounce', async (req, reply) => {
    for (const x of selected(params(req).hashes)) t.reannounce(x.id);
    return text(reply);
  });
  app.post('/api/v2/torrents/setLocation', async (req, reply) => {
    const q = params(req);
    if (!q.location || !isAbsolutePath(q.location))
      throw new CoreError('invalid_input', 'location must be an absolute path');
    for (const x of selected(q.hashes)) void t.setLocation(x.id, q.location).catch(() => undefined);
    return text(reply);
  });
  app.post('/api/v2/torrents/setCategory', async (req, reply) => {
    const q = params(req);
    for (const x of selected(q.hashes)) t.update(x.id, { category: q.category || null });
    return text(reply);
  });
  for (const [path, move] of [
    ['topPrio', 'top'],
    ['bottomPrio', 'bottom'],
    ['increasePrio', 'up'],
    ['decreasePrio', 'down'],
  ] as const)
    app.post(`/api/v2/torrents/${path}`, async (req, reply) => {
      for (const x of selected(params(req).hashes)) t.moveInQueue(x.id, move);
      return text(reply);
    });
  app.post('/api/v2/torrents/addTags', async (req, reply) => {
    const q = params(req);
    const tags = (q.tags ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    for (const x of selected(q.hashes)) t.update(x.id, { tags: [...x.tags, ...tags] });
    return text(reply);
  });
  app.post('/api/v2/torrents/removeTags', async (req, reply) => {
    const q = params(req);
    const drop = new Set((q.tags ?? '').split(',').map((x) => x.trim()));
    for (const x of selected(q.hashes))
      t.update(x.id, { tags: q.tags ? x.tags.filter((tag) => !drop.has(tag)) : [] });
    return text(reply);
  });
  // Per-torrent share limits and force-start have no equivalent; accepting them keeps the
  // callers (which set them on every grab) working. Seeding limits are DraxMax's own setting.
  for (const path of ['setShareLimits', 'setForceStart', 'setSuperSeeding', 'setAutoManagement'])
    app.post(`/api/v2/torrents/${path}`, async (_req, reply) => text(reply));

  app.get('/api/v2/torrents/categories', async () =>
    Object.fromEntries(
      core.categories.list().map((c) => [c.name, { name: c.name, savePath: c.savePath ?? '' }]),
    ),
  );
  for (const path of ['createCategory', 'editCategory'])
    app.post(`/api/v2/torrents/${path}`, async (req, reply) => {
      const q = params(req);
      if (!q.category?.trim()) throw new CoreError('invalid_input', 'category is required');
      const prev = core.categories.list().find((c) => c.name === q.category!.trim());
      const savePath = q.savePath?.trim();
      if (savePath && !isAbsolutePath(savePath))
        throw new CoreError('invalid_input', 'savePath must be an absolute path');
      core.categories.save({
        ...prev,
        name: q.category,
        savePath: savePath || prev?.savePath || null,
      });
      return text(reply);
    });
  app.post('/api/v2/torrents/removeCategories', async (req, reply) => {
    for (const name of (params(req).categories ?? '').split('\n').filter(Boolean))
      core.categories.delete(name);
    return text(reply);
  });
  app.get('/api/v2/torrents/tags', async () => t.tags());
}
