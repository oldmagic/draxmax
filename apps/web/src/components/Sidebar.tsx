import { Activity, Bell, CalendarClock, Download, Globe, Rss, Settings } from 'lucide-react';
import { motion } from 'motion/react';
import { Link, useLocation } from 'wouter';
import { NotificationBell, UnreadBadge } from '@/components/NotificationBell';
import { useUnreadCount } from '@/lib/notifications';
import { cn } from '@/lib/utils';
import { formatSpeed } from '@/lib/format';
import { useTorrents } from '@/stores/torrents';

const NAV = [
  { href: '/downloads', label: 'Downloads', icon: Download },
  { href: '/upcoming', label: 'Upcoming', icon: CalendarClock },
  { href: '/rss', label: 'RSS', icon: Rss },
  { href: '/sites', label: 'Sites', icon: Globe },
  { href: '/notifications', label: 'Notifications', icon: Bell },
  { href: '/stats', label: 'Stats', icon: Activity },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const;

export function Sidebar() {
  const [location] = useLocation();
  const torrents = useTorrents((s) => s.torrents);
  const connection = useTorrents((s) => s.connection);
  const down = torrents.reduce((s, t) => s + t.downloadSpeed, 0);
  const up = torrents.reduce((s, t) => s + t.uploadSpeed, 0);
  const active = torrents.filter((t) => t.status === 'downloading').length;
  const unread = useUnreadCount();

  return (
    <aside className="glass m-3 mr-0 hidden w-60 shrink-0 flex-col rounded-2xl p-3 md:flex">
      <div className="flex items-center gap-2.5 px-2 pb-6 pt-2">
        <img src="/favicon.svg" alt="" className="size-8" />
        <span className="text-lg font-semibold tracking-tight">DraxMax</span>
        <NotificationBell />
      </div>

      <nav aria-label="Main" className="flex flex-col gap-1">
        {NAV.map(({ href, label, icon: Icon }) => {
          const current = location === href || (href === '/downloads' && location === '/');
          return (
            <Link
              key={href}
              href={href}
              aria-current={current ? 'page' : undefined}
              className={cn(
                'relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                current ? 'text-fg' : 'text-muted hover:bg-surface-hover hover:text-fg',
              )}
            >
              {current && (
                <motion.span
                  layoutId="nav-pill"
                  className="absolute inset-0 rounded-xl bg-surface-hover ring-1 ring-border"
                  transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                />
              )}
              <Icon className={cn('relative size-[18px]', current && 'text-accent')} />
              <span className="relative">{label}</span>
              {href === '/notifications' && (
                <UnreadBadge count={unread} className="relative ml-auto" />
              )}
              {href === '/downloads' && active > 0 && (
                <span className="relative ml-auto rounded-full bg-accent/15 px-1.5 text-xs text-accent tabular">
                  {active}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto space-y-2 rounded-xl bg-surface-2 p-3 text-xs">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-muted">
            <span className="h-0.5 w-3 rounded-full bg-series-1" aria-hidden /> Download
          </span>
          <span className="font-medium tabular">{formatSpeed(down)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-muted">
            <span className="h-0.5 w-3 rounded-full bg-series-2" aria-hidden /> Upload
          </span>
          <span className="font-medium tabular">{formatSpeed(up)}</span>
        </div>
        <div className="flex items-center gap-1.5 pt-1 text-muted">
          <span
            className={cn(
              'size-1.5 rounded-full',
              connection === 'open'
                ? 'bg-success'
                : connection === 'connecting'
                  ? 'bg-warning animate-pulse'
                  : 'bg-danger',
            )}
          />
          {connection === 'open'
            ? 'Connected'
            : connection === 'connecting'
              ? 'Connecting…'
              : 'Disconnected'}
        </div>
      </div>
    </aside>
  );
}

/** Bottom navigation for narrow windows. */
export function MobileNav() {
  const [location] = useLocation();
  const unread = useUnreadCount();
  return (
    <nav
      aria-label="Main"
      className="glass fixed inset-x-3 bottom-3 z-40 flex justify-around rounded-2xl p-1.5 md:hidden"
    >
      {NAV.map(({ href, label, icon: Icon }) => {
        const current = location === href || (href === '/downloads' && location === '/');
        return (
          <Link
            key={href}
            href={href}
            aria-label={label}
            aria-current={current ? 'page' : undefined}
            className={cn(
              'relative rounded-xl p-2.5',
              current ? 'bg-surface-hover text-accent' : 'text-muted',
            )}
          >
            <Icon className="size-5" />
            {href === '/notifications' && (
              <UnreadBadge count={unread} className="absolute right-0.5 top-0.5" />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
