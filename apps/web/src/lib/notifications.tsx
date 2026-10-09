import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CalendarClock,
  CircleCheck,
  Download,
  Rss,
  ShieldAlert,
  Wrench,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { NotificationCategory, NotificationDTO } from '@draxmax/shared';
import { api } from '@/lib/api';

export const CATEGORY: Record<NotificationCategory, { label: string; icon: LucideIcon }> = {
  download: { label: 'Downloads', icon: Download },
  rss: { label: 'RSS', icon: Rss },
  upcoming: { label: 'Upcoming', icon: CalendarClock },
  security: { label: 'Security', icon: ShieldAlert },
  system: { label: 'System', icon: Wrench },
};

/** Icon and color for an entry: errors and warnings stand out, the rest shows the category. */
export function NotificationIcon({ item }: { item: NotificationDTO }) {
  if (item.level === 'error') return <XCircle className="size-4 shrink-0 text-danger" />;
  if (item.level === 'warning') return <AlertTriangle className="size-4 shrink-0 text-warning" />;
  const Icon =
    item.level === 'success' && item.category === 'download'
      ? CircleCheck
      : CATEGORY[item.category].icon;
  return (
    <Icon
      className={`size-4 shrink-0 ${item.level === 'success' ? 'text-success' : 'text-accent'}`}
    />
  );
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Unread count, kept live by the WebSocket (see stores/torrents.ts). */
export function useUnreadCount(): number {
  const { data } = useQuery({
    queryKey: ['notifications', 'count'],
    queryFn: api.notificationCount,
    refetchInterval: 120_000,
  });
  return data?.unread ?? 0;
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.markNotifications,
    onSuccess: (r) => qc.setQueryData(['notifications', 'count'], { unread: r.unread }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}
