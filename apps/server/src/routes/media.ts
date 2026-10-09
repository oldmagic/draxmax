import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CoreError, type Core } from '@draxmax/core';

const actionSchema = z.object({
  id: z.string().min(1).max(200),
  action: z.enum(['ignore', 'have', 'reset']),
});
const manualSchema = z.object({
  title: z.string().trim().min(1).max(300),
  type: z.enum(['movie', 'tv', 'anime', 'other']),
  seasonsOwned: z.array(z.number().int().min(0).max(500)).max(500).default([]),
  year: z.number().int().min(1870).max(2200).optional(),
});
const hiddenSchema = z.object({ hidden: z.boolean() });
const rangeSchema = z.object({ range: z.enum(['live', 'day']).default('live') });

/** Upcoming, library and stats endpoints. */
export async function mediaRoutes(app: FastifyInstance, { core }: { core: Core }): Promise<void> {
  const up = core.upcoming;

  app.get('/api/upcoming', async () => {
    const res = up.get();
    // First visit (or stale data): kick off a background refresh; clients get `upcoming:updated`.
    if (!res.updatedAt && !res.refreshing) void up.refresh();
    return up.get();
  });
  app.post('/api/upcoming/refresh', async () => {
    void up.refresh();
    return up.get();
  });
  app.post('/api/upcoming/action', async (req) => {
    const { id, action } = actionSchema.parse(req.body);
    return up.act(id, action);
  });

  app.get('/api/library', async () => up.library.all().map((e) => up.library.toDTO(e)));
  app.post('/api/library/rescan', async () =>
    (await up.rescanLibrary()).map((e) => up.library.toDTO(e)),
  );
  app.post('/api/library', async (req, reply) => {
    const b = manualSchema.parse(req.body);
    return reply
      .status(201)
      .send(
        up.library.toDTO(up.library.addManual(b.title, b.type, b.seasonsOwned, b.year ?? null)),
      );
  });
  app.patch('/api/library/:id', async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const row = up.library.setHidden(id, hiddenSchema.parse(req.body).hidden);
    if (!row) throw new CoreError('not_found', 'Library entry not found');
    return up.library.toDTO(row);
  });

  app.get('/api/stats', async () => core.stats.current());
  app.get('/api/stats/history', async (req) =>
    core.stats.history(rangeSchema.parse(req.query).range),
  );
}
