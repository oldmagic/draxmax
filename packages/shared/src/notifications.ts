import { z } from 'zod';

export const NOTIFICATION_CATEGORIES = [
  'download',
  'rss',
  'upcoming',
  'security',
  'system',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

/** One entry in the notification history. */
export interface NotificationDTO {
  id: number;
  category: NotificationCategory;
  level: NotificationLevel;
  title: string;
  body: string | null;
  /** In-app route to open, e.g. "/rss". */
  link: string | null;
  /** How many times this happened (repeats within a few minutes are combined). */
  count: number;
  read: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationList {
  items: NotificationDTO[];
  unread: number;
  hasMore: boolean;
}

export const notificationQuerySchema = z.object({
  unread: z.enum(['true', 'false']).optional(),
  category: z.enum(NOTIFICATION_CATEGORIES).optional(),
  q: z.string().trim().max(200).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const notificationReadSchema = z
  .object({
    ids: z.array(z.number().int().positive()).max(1000).optional(),
    all: z.boolean().optional(),
    read: z.boolean().default(true),
  })
  .refine((b) => b.all || (b.ids && b.ids.length > 0), 'Give ids or all: true');
