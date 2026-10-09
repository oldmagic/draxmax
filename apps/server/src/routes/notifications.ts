import type { FastifyInstance } from 'fastify';
import type { Core } from '@draxmax/core';
import { notificationQuerySchema, notificationReadSchema } from '@draxmax/shared';

/** Notification history: list, unread count, mark read/unread, clear. */
export async function notificationRoutes(
  app: FastifyInstance,
  { core }: { core: Core },
): Promise<void> {
  const n = core.notifications;

  app.get('/api/notifications', async (req) => {
    const q = notificationQuerySchema.parse(req.query);
    return n.list({
      unread: q.unread === 'true',
      category: q.category,
      q: q.q || undefined,
      before: q.before,
      limit: q.limit,
    });
  });
  app.get('/api/notifications/count', async () => ({ unread: n.unreadCount() }));
  app.post('/api/notifications/read', async (req) => {
    const b = notificationReadSchema.parse(req.body);
    const changed = n.markRead(b.all ? 'all' : (b.ids ?? []), b.read);
    return { changed, unread: n.unreadCount() };
  });
  app.delete('/api/notifications', async (req) => {
    const readOnly = (req.query as Record<string, string | undefined>).read === 'true';
    return { deleted: n.clear({ readOnly }), unread: n.unreadCount() };
  });
}
