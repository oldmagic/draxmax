import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CoreError, type Core } from '@draxmax/core';
import { isAbsolutePath, xdccAddSchema } from '@draxmax/shared';

const idParams = z.object({ id: z.string().min(1).max(100) });

/** XDCC transfers: start one from a search result, list, cancel, retry, remove. */
export async function xdccRoutes(app: FastifyInstance, { core }: { core: Core }): Promise<void> {
  const id = (req: { params: unknown }) => idParams.parse(req.params).id;

  app.get('/api/xdcc', async () => core.xdcc.list());

  app.post('/api/xdcc', async (req, reply) => {
    const body = xdccAddSchema.parse(req.body);
    if (body.savePath && !isAbsolutePath(body.savePath))
      throw new CoreError('invalid_input', 'Must be an absolute path');
    const t = core.search.addXdcc(body.id, body.savePath ? { savePath: body.savePath } : {});
    return reply.status(201).send(t);
  });

  app.post('/api/xdcc/:id/cancel', async (req) => core.xdcc.cancel(id(req)));
  app.post('/api/xdcc/:id/retry', async (req) => core.xdcc.retry(id(req)));
  app.delete('/api/xdcc/:id', async (req) => {
    const q = z.object({ deleteFile: z.enum(['true', 'false']).optional() }).parse(req.query);
    core.xdcc.remove(id(req), q.deleteFile === 'true');
    return { ok: true };
  });
}
