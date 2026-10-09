import type { SettingsResponse } from '@draxmax/shared';
import { desktop } from '@/lib/desktop';
import { queryClient } from '@/lib/query';

type Kind = 'complete' | 'error' | 'rss';
const KEY: Record<Kind, string> = {
  complete: 'notifyOnComplete',
  error: 'notifyOnError',
  rss: 'notifyOnRssMatch',
};

/**
 * Browser notification for an event, honouring the notification settings. The desktop
 * app shows native notifications from the main process instead, so this is web-only.
 */
export function notify(kind: Kind, title: string, body: string): void {
  if (desktop || typeof Notification === 'undefined' || Notification.permission !== 'granted')
    return;
  if (!document.hidden) return; // the in-app toast is enough while the tab is visible
  const settings = queryClient.getQueryData<SettingsResponse>(['settings']);
  if (settings && settings.settings[KEY[kind]] === false) return;
  try {
    new Notification(title, { body, icon: '/favicon.svg', tag: `${kind}:${body}` });
  } catch {
    // Some browsers only allow notifications from a service worker.
  }
}
