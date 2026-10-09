import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, Circle, CircleDot, Loader2, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useLocation } from 'wouter';
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from '@draxmax/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import {
  CATEGORY,
  NotificationIcon,
  timeAgo,
  useMarkRead,
  useUnreadCount,
} from '@/lib/notifications';
import { cn } from '@/lib/utils';

export function NotificationsPage() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const unread = useUnreadCount();
  const markRead = useMarkRead();
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [category, setCategory] = useState<NotificationCategory | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const list = useInfiniteQuery({
    queryKey: ['notifications', 'list', 'page', onlyUnread, category, query.trim()],
    queryFn: ({ pageParam }) =>
      api.notifications({
        unread: onlyUnread,
        category,
        q: query.trim(),
        before: pageParam,
        limit: 50,
      }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.items.at(-1)?.id : undefined),
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const chosen = items.filter((i) => selected.has(i.id));

  const clear = useMutation({
    mutationFn: () => api.clearNotifications(true),
    onSuccess: () => {
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
  const toggle = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-end justify-between gap-4 pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
          <p className="mt-1 text-sm text-muted">
            Everything DraxMax did or noticed. {unread ? `${unread} unread.` : 'All caught up.'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            disabled={unread === 0 || markRead.isPending}
            onClick={() => markRead.mutate({ all: true, read: true })}
          >
            <CheckCheck /> Mark all as read
          </Button>
          <Button
            variant="ghost"
            disabled={clear.isPending}
            onClick={() => confirm('Delete all read notifications?') && clear.mutate()}
          >
            <Trash2 /> Clear read
          </Button>
        </div>
      </header>

      <section className="glass flex min-h-0 flex-1 flex-col rounded-2xl">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="flex rounded-xl bg-surface-2 p-0.5 text-sm">
            {[
              [false, 'All'],
              [true, 'Unread'],
            ].map(([v, label]) => (
              <button
                key={String(label)}
                type="button"
                onClick={() => setOnlyUnread(v as boolean)}
                className={cn(
                  'rounded-lg px-3 py-1',
                  onlyUnread === v ? 'bg-bg text-fg shadow-sm' : 'text-muted hover:text-fg',
                )}
              >
                {label as string}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {NOTIFICATION_CATEGORIES.map((c) => {
              const Icon = CATEGORY[c].icon;
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={category === c}
                  onClick={() => setCategory(category === c ? null : c)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium',
                    category === c
                      ? 'bg-accent text-accent-fg'
                      : 'bg-surface-2 text-muted hover:text-fg',
                  )}
                >
                  <Icon className="size-3.5" /> {CATEGORY[c].label}
                </button>
              );
            })}
          </div>
          <div className="relative ml-auto">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              aria-label="Search notifications"
              className="h-9 w-56 pl-9"
            />
          </div>
        </div>

        {chosen.length > 0 && (
          <div className="flex items-center gap-2 border-b bg-accent/5 px-4 py-2 text-sm">
            <span>{chosen.length} selected</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                markRead.mutate({ ids: chosen.map((i) => i.id), read: true });
                setSelected(new Set());
              }}
            >
              Mark read
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                markRead.mutate({ ids: chosen.map((i) => i.id), read: false });
                setSelected(new Set());
              }}
            >
              Mark unread
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        )}

        <ul
          className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto"
          aria-label="Notifications"
        >
          {items.map((n) => (
            <li
              key={n.id}
              className={cn(
                'flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-hover/50',
                !n.read && 'bg-accent/[0.04]',
              )}
            >
              <input
                type="checkbox"
                aria-label={`Select ${n.title}`}
                checked={selected.has(n.id)}
                onChange={() => toggle(n.id)}
                className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
              />
              <span className="mt-0.5">
                <NotificationIcon item={n} />
              </span>
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => {
                  if (!n.read) markRead.mutate({ ids: [n.id], read: true });
                  if (n.link) navigate(n.link);
                }}
              >
                <span
                  className={cn('block text-sm', n.read ? 'text-muted' : 'font-medium text-fg')}
                >
                  {n.title}
                  {n.count > 1 && <span className="ml-1.5 text-xs text-muted">×{n.count}</span>}
                </span>
                {n.body && <span className="block break-words text-xs text-muted">{n.body}</span>}
                <span className="mt-0.5 block text-[11px] text-muted/80">
                  {CATEGORY[n.category].label} · {timeAgo(n.updatedAt)}
                  {n.count > 1 && ` · first ${timeAgo(n.createdAt)}`}
                </span>
              </button>
              <button
                type="button"
                title={n.read ? 'Mark unread' : 'Mark read'}
                aria-label={n.read ? `Mark ${n.title} unread` : `Mark ${n.title} read`}
                onClick={() => markRead.mutate({ ids: [n.id], read: !n.read })}
                className="rounded-lg p-1.5 text-muted hover:bg-surface-hover hover:text-fg"
              >
                {n.read ? (
                  <Circle className="size-4" />
                ) : (
                  <CircleDot className="size-4 text-accent" />
                )}
              </button>
            </li>
          ))}
          {list.isLoading && (
            <li className="grid place-items-center p-10">
              <Loader2 className="size-5 animate-spin text-muted" />
            </li>
          )}
          {!list.isLoading && items.length === 0 && (
            <li className="p-10 text-center text-sm text-muted">
              {onlyUnread || category || query
                ? 'Nothing matches these filters.'
                : 'Nothing has happened yet.'}
            </li>
          )}
          {list.hasNextPage && (
            <li className="p-3 text-center">
              <Button
                size="sm"
                variant="ghost"
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {list.isFetchingNextPage && <Loader2 className="animate-spin" />} Load more
              </Button>
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}
