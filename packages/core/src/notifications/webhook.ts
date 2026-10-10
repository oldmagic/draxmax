import type { CoreEvents } from '../events.ts';
import { fetchBytes } from '../net/http.ts';
import type { Settings } from '../settings/settings.ts';
import { redactText } from './notification-service.ts';

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Shapes a notification for the service behind `url`. ntfy takes plain text with a Title
 * header; everything else gets JSON carrying the field names the common receivers read:
 * `content` (Discord), `text` (Telegram, Slack, Mattermost), `title` + `message` (Gotify,
 * generic). Unknown fields are ignored by all of them.
 */
export function webhookRequest(url: string, title: string, message: string): WebhookRequest {
  const host = new URL(url).hostname.toLowerCase();
  if (host === 'ntfy.sh' || host.startsWith('ntfy.'))
    return {
      url,
      // Header values must be ASCII; ntfy decodes RFC 2047 for anything else.
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        title: `=?UTF-8?B?${Buffer.from(title).toString('base64')}?=`,
      },
      body: message || title,
    };
  const text = message ? `${title}\n${message}` : title;
  return {
    url,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, message, text, content: text }),
  };
}

export type WebhookSend = (req: WebhookRequest) => Promise<void>;

const defaultSend: WebhookSend = async (req) => {
  await fetchBytes(req.url, {
    method: 'POST',
    headers: req.headers,
    body: req.body,
    timeoutMs: 10_000,
    maxBytes: 64 * 1024,
  });
};

/**
 * Sends the same events the browser shows as notifications (finished, failed, RSS downloads)
 * plus security warnings to the configured webhook, so a headless server can reach a phone.
 */
export class WebhookNotifier {
  private readonly offs: (() => void)[];
  private lastError: string | null = null;

  constructor(
    private readonly deps: {
      events: CoreEvents;
      settings: () => Settings;
      send?: WebhookSend;
      onError?: (message: string) => void;
    },
  ) {
    const { events } = deps;
    const on = (key: 'notifyOnComplete' | 'notifyOnError' | 'notifyOnRssMatch') =>
      deps.settings()[key];
    this.offs = [
      events.on(
        'torrent:done',
        (t) => on('notifyOnComplete') && this.push('Download complete', t.name),
      ),
      events.on(
        'torrent:error',
        (t) => on('notifyOnError') && this.push(`Failed: ${t.name}`, t.error ?? 'Unknown error'),
      ),
      events.on(
        'rss:match',
        (m) =>
          m.status === 'added' &&
          on('notifyOnRssMatch') &&
          this.push(`RSS: ${m.ruleName}`, m.title),
      ),
      events.on('notifications:updated', ({ item }) => {
        if (item?.category === 'security' && item.level === 'warning' && item.count === 1)
          this.push(item.title, item.body ?? '');
      }),
    ];
  }

  stop(): void {
    this.offs.forEach((off) => off());
  }

  private push(title: string, message: string): void {
    void this.send(title, message).catch(() => undefined);
  }

  /** Sends one message; rejects with a readable reason. Used directly by "Send a test". */
  async send(title: string, message: string): Promise<void> {
    const url = this.deps.settings().notifyWebhookUrl;
    if (!url) throw new Error('No notification URL is set');
    try {
      await (this.deps.send ?? defaultSend)(
        webhookRequest(url, redactText(title), redactText(message)),
      );
      this.lastError = null;
    } catch (err) {
      const message = redactText((err as Error).message);
      // Report a broken webhook once, not for every event.
      if (this.lastError !== message) this.deps.onError?.(message);
      this.lastError = message;
      throw new Error(message, { cause: err });
    }
  }
}
