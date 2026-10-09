import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Core } from '@draxmax/core';
import { siteSchema, siteTestSchema } from '@draxmax/shared';

const idParams = z.object({ id: z.string().min(1).max(100) });

/** Tracker sites (credentials are write-only: responses only say which are set). */
export async function siteRoutes(app: FastifyInstance, { core }: { core: Core }): Promise<void> {
  const sites = core.sites;
  const id = (req: { params: unknown }) => idParams.parse(req.params).id;

  app.get('/api/sites', async () => sites.list());
  app.get('/api/sites/presets', async () => sites.presets());
  app.post('/api/sites', async (req, reply) =>
    reply.status(201).send(sites.saveSite(siteSchema.parse(req.body))),
  );
  app.put('/api/sites/:id', async (req) => sites.saveSite(siteSchema.parse(req.body), id(req)));
  app.patch('/api/sites/:id', async (req) =>
    sites.setEnabled(id(req), z.object({ enabled: z.boolean() }).parse(req.body).enabled),
  );
  app.delete('/api/sites/:id', async (req, reply) => {
    sites.delete(id(req));
    return reply.status(204).send();
  });
  app.post('/api/sites/:id/test', async (req) =>
    sites.test(id(req), siteTestSchema.parse(req.body).query),
  );
}
