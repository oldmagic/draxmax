import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Core } from '@draxmax/core';
import {
  articleRefSchema,
  feedCreateSchema,
  feedPatchSchema,
  markReadSchema,
  qbRuleImportSchema,
  rssConfigSaveSchema,
  ruleFeedsSchema,
  ruleIdsSchema,
  ruleSchema,
} from '@draxmax/shared';

const idParams = z.object({ id: z.string().min(1) });
const articleQuery = z.object({
  feedId: z.string().optional(),
  unread: z.enum(['true', 'false']).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function rssRoutes(app: FastifyInstance, { core }: { core: Core }): Promise<void> {
  const rss = core.rss;
  const id = (req: { params: unknown }) => idParams.parse(req.params).id;

  app.get('/api/rss/feeds', async () => rss.feeds());

  // "Follow this show": a prefilled rule for a release name, for the user to check and save.
  app.post('/api/rss/rules/suggest', async (req) =>
    rss.suggestRule(z.object({ title: z.string().trim().min(1).max(512) }).parse(req.body).title),
  );

  // Missing episodes: GET the status; POST checks everything now (or `ruleIds` only).
  app.get('/api/missing', async () => core.missing.get());
  app.post('/api/missing/check', async (req) => {
    const body = z
      .object({ ruleIds: z.array(z.string().min(1)).max(1000).optional() })
      .parse(req.body ?? {});
    void core.missing.run(body.ruleIds ? { ruleIds: body.ruleIds } : { force: true });
    return core.missing.get();
  });
  app.post('/api/rss/feeds', async (req, reply) => {
    const body = feedCreateSchema.parse(req.body);
    return reply.status(201).send(await rss.addFeed(body.url, body.refreshMinutes ?? null));
  });
  app.patch('/api/rss/feeds/:id', async (req) =>
    rss.updateFeed(id(req), feedPatchSchema.parse(req.body)),
  );
  app.delete('/api/rss/feeds/:id', async (req, reply) => {
    rss.deleteFeed(id(req));
    return reply.status(204).send();
  });
  app.post('/api/rss/feeds/:id/refresh', async (req) => rss.refreshFeed(id(req)));
  app.post('/api/rss/refresh', async () => {
    await rss.refreshAll();
    return rss.feeds();
  });

  app.get('/api/rss/articles', async (req) => {
    const q = articleQuery.parse(req.query);
    return rss.articles({
      feedId: q.feedId,
      unreadOnly: q.unread === 'true',
      query: q.q,
      limit: q.limit,
      offset: q.offset,
    });
  });
  app.post('/api/rss/articles/read', async (req, reply) => {
    const body = markReadSchema.parse(req.body);
    rss.markRead(body.read, { feedId: body.feedId, articles: body.articles });
    return reply.status(204).send();
  });
  app.post('/api/rss/articles/download', async (req) => {
    const { feedId, id: articleId } = articleRefSchema.parse(req.body);
    return rss.downloadArticle(feedId, articleId);
  });

  app.get('/api/rss/rules', async () => rss.rules());
  app.post('/api/rss/rules', async (req, reply) =>
    reply.status(201).send(await rss.saveRule(ruleSchema.parse(req.body))),
  );
  app.put('/api/rss/rules/:id', async (req) => rss.saveRule(ruleSchema.parse(req.body), id(req)));
  app.delete('/api/rss/rules/:id', async (req, reply) => {
    rss.deleteRule(id(req));
    return reply.status(204).send();
  });
  app.post('/api/rss/rules/delete', async (req) => ({
    deleted: rss.deleteRules(ruleIdsSchema.parse(req.body).ids),
  }));
  // Feeds and rules as one JSON document (Edit as JSON).
  app.get('/api/rss/config', async () => rss.exportConfig());
  app.put('/api/rss/config', async (req) => {
    const { removeMissing, ...cfg } = rssConfigSaveSchema.parse(req.body);
    return rss.importConfig(cfg, removeMissing);
  });
  app.post('/api/rss/rules/feeds', async (req) =>
    rss.setRuleFeeds(ruleFeedsSchema.parse(req.body)),
  );
  app.post('/api/rss/rules/import', async (req) => {
    const { rules, ...opts } = qbRuleImportSchema.parse(req.body);
    return rss.importQbRules(rules, opts);
  });
  app.post('/api/rss/rules/preview', async (req) => rss.preview(ruleSchema.parse(req.body)));

  app.get('/api/rss/history', async () => rss.history());
  app.delete('/api/rss/history', async (_req, reply) => {
    rss.clearHistory();
    return reply.status(204).send();
  });
}
