import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Core } from '@draxmax/core';
import {
  addMagnetSchema,
  addTorrentFileSchema,
  categorySchema,
  queueMoveSchema,
  removeTorrentSchema,
  setFilesSchema,
  trackerToggleSchema,
  trackerUrlsSchema,
  updateTorrentSchema,
} from '@draxmax/shared';

const idParams = z.object({ id: z.string().min(1) });
const nameParams = z.object({ name: z.string().min(1) });

/** Torrent, tracker and category endpoints. */
export async function torrentRoutes(app: FastifyInstance, { core }: { core: Core }): Promise<void> {
  const t = core.torrents;
  const id = (req: { params: unknown }) => idParams.parse(req.params).id;

  app.get('/api/torrents', async () => t.list());
  app.get('/api/torrents/:id', async (req) => t.get(id(req)));

  app.post('/api/torrents/magnet', async (req, reply) => {
    const body = addMagnetSchema.parse(req.body);
    return reply.status(201).send(t.addMagnet(body.magnetURI, body));
  });

  app.post('/api/torrents/file', async (req, reply) => {
    const body = addTorrentFileSchema.parse(req.body);
    return reply.status(201).send(await t.addTorrentFile(Buffer.from(body.data, 'base64'), body));
  });

  app.post('/api/torrents/pause-all', async (_req, reply) => {
    await t.pauseAll();
    return reply.status(204).send();
  });
  app.post('/api/torrents/resume-all', async (_req, reply) => {
    t.resumeAll();
    return reply.status(204).send();
  });

  app.patch('/api/torrents/:id', async (req) =>
    t.update(id(req), updateTorrentSchema.parse(req.body)),
  );
  app.post('/api/torrents/:id/pause', async (req) => t.pause(id(req)));
  app.post('/api/torrents/:id/resume', async (req) => t.resume(id(req)));
  app.post('/api/torrents/:id/reannounce', async (req) => t.reannounce(id(req)));
  app.post('/api/torrents/:id/recheck', async (req) => t.recheck(id(req)));
  app.post('/api/torrents/:id/queue', async (req) =>
    t.moveInQueue(id(req), queueMoveSchema.parse(req.body).move),
  );
  app.get('/api/torrents/:id/peers', async (req) => t.peers(id(req)));

  app.patch('/api/torrents/:id/files', async (req) => {
    const { files } = setFilesSchema.parse(req.body);
    return t.setFilePriorities(id(req), files);
  });

  app.delete('/api/torrents/:id', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const { deleteFiles } = removeTorrentSchema.parse({ deleteFiles: q.deleteFiles === 'true' });
    await t.remove(id(req), deleteFiles);
    return reply.status(204).send();
  });

  // Trackers
  app.post('/api/torrents/:id/trackers', async (req) =>
    t.addTrackers(id(req), trackerUrlsSchema.parse(req.body).urls),
  );
  app.delete('/api/torrents/:id/trackers', async (req) =>
    t.removeTrackers(id(req), trackerUrlsSchema.parse(req.body).urls),
  );
  app.patch('/api/torrents/:id/trackers', async (req) => {
    const body = trackerToggleSchema.parse(req.body);
    return t.setTrackerEnabled(id(req), body.url, body.enabled);
  });

  // Categories & tags
  app.get('/api/categories', async () => core.categories.list());
  app.put('/api/categories/:name', async (req) => {
    const { name } = nameParams.parse(req.params);
    const body = categorySchema.parse({ ...(req.body as object), name });
    return core.categories.save({ name: body.name, savePath: body.savePath ?? null });
  });
  app.delete('/api/categories/:name', async (req, reply) => {
    core.categories.delete(nameParams.parse(req.params).name);
    return reply.status(204).send();
  });
  app.get('/api/tags', async () => t.tags());
}
