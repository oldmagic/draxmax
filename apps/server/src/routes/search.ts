import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Core } from '@draxmax/core';
import {
  isAbsolutePath,
  searchAddSchema,
  searchQuerySchema,
  sourceTestSchema,
  torznabAddSchema,
} from '@draxmax/shared';
import { CoreError } from '@draxmax/core';

const idParams = z.object({ id: z.string().min(1).max(100) });

/** In-app search and the list of places it searches. */
export async function searchRoutes(app: FastifyInstance, { core }: { core: Core }): Promise<void> {
  const search = core.search;
  const id = (req: { params: unknown }) => idParams.parse(req.params).id;

  app.get('/api/search', async (req) => {
    const q = searchQuerySchema.parse(req.query);
    return search.search(q.q, q.type ?? null);
  });

  app.post('/api/search/add', async (req, reply) => {
    const body = searchAddSchema.parse(req.body);
    if (body.savePath && !isAbsolutePath(body.savePath))
      throw new CoreError('invalid_input', 'Must be an absolute path');
    const torrent = await search.add(body.id, {
      ...(body.category ? { category: body.category } : {}),
      ...(body.savePath ? { savePath: body.savePath } : {}),
      ...(body.paused !== undefined ? { paused: body.paused } : {}),
    });
    return reply.status(201).send(torrent);
  });

  app.get('/api/search/sources', async () => search.sourceList());
  app.post('/api/search/sources/torznab', async (req, reply) => {
    search.addTorznab(torznabAddSchema.parse(req.body).url);
    return reply.status(201).send(search.sourceList());
  });
  app.patch('/api/search/sources/:id', async (req) => {
    search.setBuiltinEnabled(id(req), z.object({ enabled: z.boolean() }).parse(req.body).enabled);
    return search.sourceList();
  });
  app.delete('/api/search/sources/:id', async (req) => {
    const m = /^torznab:(\d+)$/.exec(id(req));
    if (!m) throw new CoreError('not_found', 'Only Torznab indexers can be removed here');
    search.removeTorznab(Number(m[1]));
    return search.sourceList();
  });
  app.post('/api/search/sources/:id/test', async (req) =>
    search.testSource(id(req), sourceTestSchema.parse(req.body).query),
  );
}
