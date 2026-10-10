import type { TorrentStatus } from '@draxmax/shared';
import type { BadgeTone } from '@/components/ui/badge';
import type { ProgressTone } from '@/components/ui/progress';

export const STATUS_META: Record<
  TorrentStatus,
  { label: string; badge: BadgeTone; bar: ProgressTone }
> = {
  downloading: { label: 'Downloading', badge: 'accent', bar: 'accent' },
  seeding: { label: 'Seeding', badge: 'success', bar: 'success' },
  paused: { label: 'Paused', badge: 'muted', bar: 'muted' },
  queued: { label: 'Queued', badge: 'muted', bar: 'muted' },
  error: { label: 'Error', badge: 'danger', bar: 'danger' },
  checking: { label: 'Checking', badge: 'warning', bar: 'warning' },
  metadata: { label: 'Fetching metadata', badge: 'info', bar: 'muted' },
  moving: { label: 'Moving files', badge: 'warning', bar: 'warning' },
};
