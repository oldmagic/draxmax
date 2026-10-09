import * as Menu from '@radix-ui/react-dropdown-menu';
import { useQuery } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import { useLocation } from 'wouter';
import { api } from '@/lib/api';
import { NotificationIcon, timeAgo, useMarkRead, useUnreadCount } from '@/lib/notifications';
import { cn } from '@/lib/utils';

export function UnreadBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        'min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-semibold leading-4 text-white tabular',
        className,
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

/** Bell with the unread count; opens the latest entries. */
export function NotificationBell() {
  const unread = useUnreadCount();
  const [, navigate] = useLocation();
  const markRead = useMarkRead();
  const { data } = useQuery({
    queryKey: ['notifications', 'list', 'bell'],
    queryFn: () => api.notifications({ limit: 15 }),
  });
  const items = data?.items ?? [];

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        className="relative ml-auto rounded-xl p-2 text-muted transition-colors hover:bg-surface-hover hover:text-fg data-[state=open]:bg-surface-hover data-[state=open]:text-fg"
      >
        <Bell className="size-[18px]" />
        <UnreadBadge count={unread} className="absolute -right-0.5 -top-0.5" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align="start"
          sideOffset={8}
          className="glass z-50 flex max-h-[min(34rem,80dvh)] w-[min(92vw,24rem)] flex-col rounded-2xl !bg-bg/95 p-1.5 data-[state=open]:animate-[fade-in_120ms_ease-out]"
        >
          <div className="flex items-center justify-between px-2.5 py-2">
            <span className="text-sm font-semibold">Notifications</span>
            <button
              type="button"
              disabled={unread === 0}
              onClick={() => markRead.mutate({ all: true, read: true })}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted hover:bg-surface-hover hover:text-fg disabled:opacity-40"
            >
              <CheckCheck className="size-3.5" /> Mark all as read
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {items.map((n) => (
              <Menu.Item
                key={n.id}
                onSelect={() => {
                  if (!n.read) markRead.mutate({ ids: [n.id], read: true });
                  if (n.link) navigate(n.link);
                }}
                className="flex cursor-default gap-2.5 rounded-xl px-2.5 py-2 outline-none data-[highlighted]:bg-surface-hover"
              >
                <span className="mt-0.5">
                  <NotificationIcon item={n} />
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'block truncate text-sm',
                      n.read ? 'text-muted' : 'font-medium text-fg',
                    )}
                    title={n.title}
                  >
                    {n.title}
                    {n.count > 1 && <span className="ml-1 text-xs text-muted">×{n.count}</span>}
                  </span>
                  {n.body && (
                    <span className="block truncate text-xs text-muted" title={n.body}>
                      {n.body}
                    </span>
                  )}
                  <span className="block text-[11px] text-muted/80">{timeAgo(n.updatedAt)}</span>
                </span>
                {!n.read && (
                  <span
                    aria-label="Unread"
                    className="mt-1.5 size-2 shrink-0 rounded-full bg-accent"
                  />
                )}
              </Menu.Item>
            ))}
            {items.length === 0 && (
              <p className="px-3 py-8 text-center text-sm text-muted">Nothing has happened yet.</p>
            )}
          </div>
          <Menu.Item
            onSelect={() => navigate('/notifications')}
            className="mt-1 cursor-default rounded-xl border-t px-2.5 py-2 text-center text-sm text-accent outline-none data-[highlighted]:bg-surface-hover"
          >
            See all
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
