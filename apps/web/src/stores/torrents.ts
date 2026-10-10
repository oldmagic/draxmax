import { create } from 'zustand';
import { toast } from 'sonner';
import type { ServerEvent, TorrentDTO } from '@draxmax/shared';
import { wsUrl } from '@/lib/api';
import { notify } from '@/lib/notify';
import { queryClient } from '@/lib/query';
import { useStats } from '@/stores/stats';

export type ConnectionState = 'connecting' | 'open' | 'closed';

interface TorrentState {
  torrents: TorrentDTO[];
  connection: ConnectionState;
  /** Optimistically merge a torrent returned by a mutation, ahead of the next snapshot. */
  upsert(t: TorrentDTO): void;
  drop(id: string): void;
}

export const useTorrents = create<TorrentState>((set) => ({
  torrents: [],
  connection: 'connecting',
  upsert: (t) =>
    set((s) => {
      const i = s.torrents.findIndex((x) => x.id === t.id);
      if (i === -1) return { torrents: [...s.torrents, t] };
      const next = s.torrents.slice();
      next[i] = t;
      return { torrents: next };
    }),
  drop: (id) => set((s) => ({ torrents: s.torrents.filter((t) => t.id !== id) })),
}));

function handle(event: ServerEvent): void {
  switch (event.type) {
    case 'torrents:snapshot':
      useTorrents.setState({ torrents: event.torrents });
      break;
    case 'torrents:delta': {
      const byId = new Map(useTorrents.getState().torrents.map((t) => [t.id, t]));
      for (const t of event.changed) byId.set(t.id, t);
      // `order` is sent when the list's membership or order changed.
      const torrents = event.order
        ? event.order.flatMap((id) => byId.get(id) ?? [])
        : useTorrents.getState().torrents.map((t) => byId.get(t.id)!);
      useTorrents.setState({ torrents });
      break;
    }
    case 'torrent:added':
      useTorrents.getState().upsert(event.torrent);
      break;
    case 'torrent:removed':
      useTorrents.getState().drop(event.id);
      break;
    case 'torrent:done':
      toast.success('Download complete', { description: event.name });
      notify('complete', 'Download complete', event.name);
      break;
    case 'torrent:seeded':
      toast.info('Finished seeding', {
        description: event.removed
          ? `${event.name} was removed from the list. Its files were kept.`
          : `${event.name} reached its seeding limit and was stopped.`,
      });
      break;
    case 'torrent:error':
      toast.error(`Error: ${event.name}`, { description: event.error });
      notify('error', `Error: ${event.name}`, event.error);
      break;
    case 'rss:updated':
      void queryClient.invalidateQueries({ queryKey: ['rss'] });
      break;
    case 'rss:match':
      if (event.status === 'added') {
        toast.success(`RSS: ${event.ruleName}`, { description: event.title });
        notify('rss', `RSS: ${event.ruleName}`, event.title);
      }
      void queryClient.invalidateQueries({ queryKey: ['rss'] });
      break;
    case 'stats:tick':
      useStats.getState().push(event.stats);
      break;
    case 'upcoming:updated':
      void queryClient.invalidateQueries({ queryKey: ['upcoming'] });
      break;
    case 'missing:updated':
      void queryClient.invalidateQueries({ queryKey: ['missing'] });
      break;
    case 'sites:updated':
      void queryClient.invalidateQueries({ queryKey: ['sites'] });
      break;
    case 'notifications:updated':
      queryClient.setQueryData(['notifications', 'count'], { unread: event.unread });
      void queryClient.invalidateQueries({ queryKey: ['notifications', 'list'] });
      // Security warnings also reach a hidden tab as a browser notification.
      if (
        event.item?.category === 'security' &&
        event.item.level === 'warning' &&
        event.item.count === 1
      )
        notify('error', event.item.title, event.item.body ?? '');
      break;
  }
}

let started = false;

/** Opens the live WebSocket feed, reconnecting with capped exponential backoff. */
export function startLiveFeed(): void {
  if (started) return;
  started = true;
  let attempt = 0;

  const connect = () => {
    useTorrents.setState({ connection: 'connecting' });
    const ws = new WebSocket(wsUrl('/api/ws'));
    ws.onopen = () => {
      attempt = 0;
      useTorrents.setState({ connection: 'open' });
    };
    ws.onmessage = (msg) => {
      try {
        handle(JSON.parse(String(msg.data)) as ServerEvent);
      } catch (err) {
        console.error('Bad server event', err);
      }
    };
    ws.onclose = () => {
      useTorrents.setState({ connection: 'closed' });
      const delay = Math.min(10_000, 500 * 2 ** attempt++);
      setTimeout(connect, delay);
    };
  };
  connect();
}
