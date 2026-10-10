import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCore, type Core } from '../core.ts';
import { FakeEngine } from '../testing/index.ts';
import { redactText } from './notification-service.ts';

const MAGNET = 'magnet:?xt=urn:btih:c9e15763f722f23e98a29decdfae341b98d53056&dn=Cosmos';

let dir: string;
let core: Core;
let feedXml: string | Error = '';
const fetchFeed = vi.fn(async () => {
  if (feedXml instanceof Error) throw feedXml;
  return feedXml;
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'draxmax-notify-'));
  core = createCore({
    configPath: join(dir, 'c'),
    downloadPath: join(dir, 'd'),
    engine: new FakeEngine(),
    env: {},
    noSchedulers: true,
    rssFetch: { fetchFeed },
  });
});
afterEach(async () => {
  await core.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('NotificationService', () => {
  it('lists, filters, searches and tracks read state', () => {
    const n = core.notifications;
    n.add({ category: 'download', level: 'success', title: 'Finished: Linux ISO' });
    n.add({ category: 'rss', level: 'success', title: 'RSS: Show', body: 'Show S01E02' });
    n.add({ category: 'security', level: 'warning', title: 'Failed login' });
    expect(n.unreadCount()).toBe(3);
    expect(n.list().items.map((i) => i.title)).toEqual([
      'Failed login',
      'RSS: Show',
      'Finished: Linux ISO',
    ]);
    expect(n.list({ category: 'rss' }).items).toHaveLength(1);
    expect(n.list({ q: 'S01E02' }).items[0]!.title).toBe('RSS: Show');
    expect(n.list({ q: '100%_' }).items).toHaveLength(0);

    const [first] = n.list().items;
    expect(n.markRead([first!.id], true)).toBe(1);
    expect(n.unreadCount()).toBe(2);
    expect(n.list({ unread: true }).items).toHaveLength(2);
    expect(n.markRead('all', true)).toBe(2);
    expect(n.unreadCount()).toBe(0);
    n.markRead([first!.id], false);
    expect(n.unreadCount()).toBe(1);
    expect(n.clear({ readOnly: true })).toBe(2);
    expect(n.list().items.map((i) => i.title)).toEqual(['Failed login']);
  });

  it('combines repeats with the same key and pages with a cursor', () => {
    const n = core.notifications;
    for (let i = 0; i < 5; i++)
      n.add({
        category: 'security',
        level: 'warning',
        title: 'Failed login from 1.2.3.4',
        dedupeKey: 'ip',
      });
    const items = n.list().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.count).toBe(5);
    // Once read, a repeat starts a new entry.
    n.markRead('all', true);
    n.add({
      category: 'security',
      level: 'warning',
      title: 'Failed login from 1.2.3.4',
      dedupeKey: 'ip',
    });
    expect(n.list().items).toHaveLength(2);

    for (let i = 0; i < 5; i++) n.add({ category: 'system', level: 'info', title: `Item ${i}` });
    const page1 = n.list({ limit: 3 });
    expect(page1.hasMore).toBe(true);
    const page2 = n.list({ limit: 3, before: page1.items.at(-1)!.id });
    expect(page2.items.map((i) => i.title)).toEqual([
      'Item 1',
      'Item 0',
      'Failed login from 1.2.3.4',
    ]);
  });

  it('respects the per-category switches and hides credentials', () => {
    core.settings.update({ historyUpcoming: false });
    expect(core.notifications.add({ category: 'upcoming', level: 'info', title: 'x' })).toBeNull();
    expect(redactText('Feed failing: https://t.example/rss.php?passkey=abc123&x=1')).toBe(
      'Feed failing: https://t.example/rss.php?passkey=•••&x=1',
    );
    const item = core.notifications.add({
      category: 'rss',
      level: 'warning',
      title: 'Feed failing',
      body: 'HTTP 401 from https://t.example/rss?apikey=SECRET',
    });
    expect(item!.body).not.toContain('SECRET');
  });
});

describe('recorded events', () => {
  it('records added torrents with their origin, and settings changes by name only', () => {
    core.torrents.addMagnet(MAGNET, { origin: 'manual' });
    core.settings.update({ rssRefreshMinutes: 45, tmdbApiKey: 'SECRETKEY' });
    const items = core.notifications.list().items;
    expect(items.find((i) => i.category === 'download')).toMatchObject({
      title: 'Added: Cosmos',
      body: 'Added by you',
    });
    const settings = items.find((i) => i.title === 'Settings changed')!;
    expect(settings.body).toBe('rssRefreshMinutes, tmdbApiKey');
    expect(JSON.stringify(items)).not.toContain('SECRETKEY');
  });

  it('records a failing feed once, then its recovery', async () => {
    feedXml =
      '<?xml version="1.0"?><rss version="2.0"><channel><title>My Feed</title></channel></rss>';
    const feed = await core.rss.addFeed('https://feeds.example/rss?passkey=PK1234');
    feedXml = new Error('HTTP 401 from feeds.example');
    await core.rss.refreshFeed(feed.id);
    await core.rss.refreshFeed(feed.id);
    let rss = core.notifications.list({ category: 'rss' }).items;
    expect(rss).toHaveLength(1);
    expect(rss[0]).toMatchObject({
      title: 'Feed failing: My Feed',
      body: 'HTTP 401 from feeds.example',
      count: 1,
    });
    feedXml =
      '<?xml version="1.0"?><rss version="2.0"><channel><title>My Feed</title></channel></rss>';
    await core.rss.refreshFeed(feed.id);
    rss = core.notifications.list({ category: 'rss' }).items;
    expect(rss[0]!.title).toBe('Feed works again: My Feed');
  });

  it('records missing-episode runs and failing search sources', () => {
    core.events.emit('missing:run', {
      added: 2,
      failing: [
        { source: 'Site: SuperBits', error: 'Got a login page: check the session cookies' },
      ],
    });
    core.events.emit('missing:run', {
      added: 0,
      failing: [
        { source: 'Site: SuperBits', error: 'Got a login page: check the session cookies' },
      ],
    });
    const items = core.notifications.list().items;
    expect(items.find((i) => i.title === 'Missing episodes: 2 added')).toBeTruthy();
    const failing = items.filter((i) => i.title === 'Search failing: Site: SuperBits');
    expect(failing).toHaveLength(1);
    expect(failing[0]).toMatchObject({ count: 2, link: '/sites', level: 'warning' });
  });

  it('records new For You items, but not the first time Upcoming fills in', () => {
    const announce = (items: { id: string; title: string; reason?: string }[]) =>
      (Reflect.get(core.upcoming, 'announceNew') as (i: unknown[]) => void).call(
        core.upcoming,
        items.map((i) => ({ ...i, matchedLibraryEntries: [] })),
      );
    announce([{ id: 'a', title: 'The Expanse', reason: 'Season 6 of The Expanse is out' }]);
    expect(core.notifications.list({ category: 'upcoming' }).items).toHaveLength(0);
    announce([
      { id: 'a', title: 'The Expanse', reason: 'Season 6 of The Expanse is out' },
      { id: 'b', title: 'Frieren', reason: 'Sequel to Frieren' },
    ]);
    expect(core.notifications.list({ category: 'upcoming' }).items.map((i) => i.title)).toEqual([
      'Sequel to Frieren',
    ]);
  });
});
