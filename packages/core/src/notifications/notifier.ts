import type { CoreEvents } from '../events.ts';
import type { NotificationService } from './notification-service.ts';

const ORIGIN: Record<string, (detail: string | null) => string> = {
  manual: (d) => (d ? `Added by you (${d})` : 'Added by you'),
  rss: (d) => `From RSS rule “${d ?? '?'}”`,
  missing: (d) => `Missing episode for “${d ?? '?'}”`,
  watch: () => 'From the watch folder',
  api: () => 'Added through the API',
};

/**
 * Turns core events into notification history entries. Producers only emit events; this is
 * the one place that decides what is worth recording and how it reads.
 */
export function wireNotifications(events: CoreEvents, n: NotificationService): () => void {
  const offs = [
    // One entry per added torrent; RSS and missing-episode downloads are filed under RSS.
    events.on('torrent:added', (t, { origin, detail }) =>
      n.add({
        category: origin === 'rss' || origin === 'missing' ? 'rss' : 'download',
        level: origin === 'rss' || origin === 'missing' ? 'success' : 'info',
        title:
          origin === 'rss'
            ? `RSS: ${detail ?? 'rule'}`
            : origin === 'missing'
              ? `Missing episode: ${detail ?? 'rule'}`
              : `Added: ${t.name}`,
        body:
          origin === 'rss' || origin === 'missing'
            ? t.name
            : (ORIGIN[origin] ?? ORIGIN.api!)(detail),
        link: '/downloads',
      }),
    ),
    events.on('torrent:done', (t) =>
      n.add({
        category: 'download',
        level: 'success',
        title: `Finished: ${t.name}`,
        link: '/downloads',
      }),
    ),
    events.on('torrent:error', (t) =>
      n.add({
        category: 'download',
        level: 'error',
        title: `Failed: ${t.name}`,
        body: t.error ?? 'Unknown error',
        link: '/downloads',
        dedupeKey: `torrent-error:${t.id}`,
      }),
    ),
    events.on('torrent:seeded', (t) =>
      n.add({
        category: 'download',
        level: 'info',
        title: `Finished seeding: ${t.name}`,
        body: 'Removed from the list after reaching the seeding time limit. Its files were kept.',
        link: '/downloads',
      }),
    ),
    events.on('rss:feed-status', (f) =>
      n.add(
        f.ok
          ? {
              category: 'rss',
              level: 'success',
              title: `Feed works again: ${f.title}`,
              link: '/rss',
            }
          : {
              category: 'rss',
              level: 'warning',
              title: `Feed failing: ${f.title}`,
              body: f.error,
              link: '/rss',
              dedupeKey: `feed:${f.feedId}`,
            },
      ),
    ),
    events.on('missing:run', (r) => {
      if (r.added > 0)
        n.add({
          category: 'rss',
          level: 'success',
          title: `Missing episodes: ${r.added} added`,
          link: '/rss',
          dedupeKey: 'missing:added',
        });
      for (const f of r.failing)
        n.add({
          category: 'rss',
          level: 'warning',
          title: `Search failing: ${f.source}`,
          body: f.error,
          link: f.source.startsWith('Site: ') ? '/sites' : '/rss',
          dedupeKey: `source:${f.source}`,
        });
    }),
    events.on('upcoming:new', (items) => {
      for (const i of items.slice(0, 20))
        n.add({
          category: 'upcoming',
          level: 'info',
          title: i.reason ?? `New: ${i.title}`,
          body: i.title,
          link: '/upcoming',
        });
    }),
    events.on('engine:warning', (err) =>
      n.add({
        category: 'system',
        level: 'warning',
        title: 'BitTorrent engine warning',
        body: err.message,
        dedupeKey: `engine:${err.message}`,
      }),
    ),
    events.on('engine:fatal', (err) =>
      n.add({
        category: 'system',
        level: 'error',
        title: 'BitTorrent engine stopped',
        body: err.message,
      }),
    ),
  ];
  return () => offs.forEach((off) => off());
}
