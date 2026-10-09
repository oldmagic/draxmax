import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rssConfigSchema } from '@draxmax/shared';
import { createCore, type Core } from '../core.ts';
import { FakeEngine, makeTorrentFile } from '../testing/index.ts';

const hash = (n: number) => n.toString(16).padStart(40, '0');

function feedXml(items: { title: string; hash?: number; link?: string; date: string }[]): string {
  return `<?xml version="1.0"?>
<rss version="2.0" xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel><title>Test Feed</title>
${items
  .map(
    (i) => `<item><title>${i.title}</title><guid>${i.title}</guid><pubDate>${i.date}</pubDate>
  <link>${i.link ?? `https://example.org/view/${i.hash}`}</link>${i.hash !== undefined ? `<nyaa:infoHash>${hash(i.hash)}</nyaa:infoHash>` : ''}<nyaa:size>1.5 GiB</nyaa:size></item>`,
  )
  .join('\n')}
</channel></rss>`;
}

let dir: string;
let core: Core;
let xml: string;
const fetchFeed = vi.fn(async () => xml);
const fetchTorrent = vi.fn(async () =>
  makeTorrentFile('FromUrl', [{ path: ['f.bin'], length: 10 }]),
);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'draxmax-rss-'));
  core = createCore({
    configPath: join(dir, 'c'),
    downloadPath: join(dir, 'd'),
    engine: new FakeEngine(),
    env: {},
    noSchedulers: true,
    rssFetch: { fetchFeed, fetchTorrent },
  });
});
afterEach(async () => {
  await core.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('RssService', () => {
  it('adds a feed, takes its title, and stores articles with torrent links and sizes', async () => {
    xml = feedXml([
      { title: 'Show S01E01 1080p', hash: 1, date: 'Mon, 01 Jan 2026 10:00:00 GMT' },
      {
        title: 'Other Thing',
        link: 'https://example.org/x.torrent',
        date: 'Mon, 01 Jan 2026 11:00:00 GMT',
      },
    ]);
    const feed = await core.rss.addFeed('https://feeds.example/rss');
    expect(feed).toMatchObject({ title: 'Test Feed', unread: 2, total: 2, lastError: null });
    const articles = core.rss.articles({});
    expect(articles.map((a) => a.title)).toEqual(['Other Thing', 'Show S01E01 1080p']);
    expect(articles[1]!.torrentURL).toMatch(/^magnet:\?xt=urn:btih:0+1&dn=Show/);
    expect(articles[1]!.size).toBe(Math.round(1.5 * 1024 ** 3));
    await expect(core.rss.addFeed('https://feeds.example/rss')).rejects.toThrow(/already/);
  });

  it('records fetch failures with backoff instead of throwing', async () => {
    fetchFeed.mockRejectedValueOnce(new Error('HTTP 503 from feeds.example'));
    const feed = await core.rss.addFeed('https://feeds.example/broken');
    expect(feed.lastError).toBe('HTTP 503 from feeds.example');
    expect(Date.parse(feed.nextFetchAt!)).toBeGreaterThan(Date.now());
  });

  it('applies rules to new articles with smart episode filtering, category and history', async () => {
    xml = feedXml([{ title: 'Unrelated', hash: 9, date: 'Mon, 01 Jan 2026 09:00:00 GMT' }]);
    const feed = await core.rss.addFeed('https://feeds.example/rss');
    const onMatch = vi.fn();
    core.events.on('rss:match', onMatch);
    await core.rss.saveRule({
      name: 'My Show',
      enabled: true,
      priority: 0,
      mustContain: ['show 1080p'],
      mustNotContain: [],
      useRegex: false,
      smartEpisodeFilter: true,
      assignedFeedIds: [],
      category: 'TV',
      tags: ['auto'],
      addPaused: false,
    });

    xml = feedXml([
      { title: 'Show S01E01 1080p WEB', hash: 1, date: 'Mon, 01 Jan 2026 10:00:00 GMT' },
      { title: 'Show S01E01 1080p AMZN', hash: 2, date: 'Mon, 01 Jan 2026 10:05:00 GMT' },
      { title: 'Show S01E02 720p', hash: 3, date: 'Mon, 01 Jan 2026 10:10:00 GMT' },
      { title: 'Show S01E02 1080p', hash: 4, date: 'Mon, 01 Jan 2026 10:15:00 GMT' },
      { title: 'Unrelated', hash: 9, date: 'Mon, 01 Jan 2026 09:00:00 GMT' },
    ]);
    await core.rss.refreshFeed(feed.id);

    const torrents = core.torrents.list();
    expect(torrents.map((t) => t.name)).toEqual(['Show S01E01 1080p WEB', 'Show S01E02 1080p']);
    expect(torrents[0]).toMatchObject({ category: 'TV', tags: ['auto'] });
    expect(onMatch).toHaveBeenCalledTimes(2);
    expect(core.rss.history().map((h) => [h.articleTitle, h.status])).toEqual([
      ['Show S01E02 1080p', 'added'],
      ['Show S01E01 1080p WEB', 'added'],
    ]);
    const matched = core.rss.articles({ feedId: feed.id }).filter((a) => a.downloaded);
    expect(matched.every((a) => a.isRead)).toBe(true);
  });

  it('applies a newly saved rule to existing articles and previews matches', async () => {
    xml = feedXml([
      {
        title: 'Linux ISO 24.04',
        link: 'https://example.org/linux.torrent',
        date: 'Mon, 01 Jan 2026 10:00:00 GMT',
      },
      { title: 'Something else', hash: 5, date: 'Mon, 01 Jan 2026 10:00:00 GMT' },
    ]);
    await core.rss.addFeed('https://feeds.example/rss');
    const input = {
      name: 'ISOs',
      enabled: true,
      priority: 0,
      mustContain: ['linux*iso'],
      mustNotContain: [],
      useRegex: false,
      smartEpisodeFilter: false,
      assignedFeedIds: [],
      tags: [],
      addPaused: true,
    };
    expect(core.rss.preview(input).map((a) => a.title)).toEqual(['Linux ISO 24.04']);
    await core.rss.saveRule(input);
    // The link is on another host than the feed, so it may only reach public addresses.
    expect(fetchTorrent).toHaveBeenCalledWith('https://example.org/linux.torrent', {
      allowPrivate: false,
      headers: {},
    });
    expect(core.torrents.list()).toMatchObject([{ name: 'FromUrl', status: 'paused' }]);
    await expect(
      core.rss.saveRule({ ...input, useRegex: true, mustContain: ['(oops'] }),
    ).rejects.toThrow(/Invalid regular/);
  });

  it('downloads an article manually and marks it read', async () => {
    xml = feedXml([{ title: 'Manual Pick', hash: 7, date: 'Mon, 01 Jan 2026 10:00:00 GMT' }]);
    const feed = await core.rss.addFeed('https://feeds.example/rss');
    const [a] = core.rss.articles({ feedId: feed.id });
    expect(await core.rss.downloadArticle(feed.id, a!.id)).toMatchObject({ status: 'added' });
    expect(await core.rss.downloadArticle(feed.id, a!.id)).toMatchObject({ status: 'duplicate' });
    expect(core.rss.articles({ feedId: feed.id })[0]).toMatchObject({
      isRead: true,
      downloaded: true,
    });
    core.rss.markRead(false, { feedId: feed.id });
    expect(core.rss.feeds()[0]!.unread).toBe(1);
  });

  it('imports a qBittorrent rules export, mapping feeds by URL and adding missing ones', async () => {
    xml = feedXml([
      {
        title: '[SubsPlease] Astro Note - 05 (1080p)',
        hash: 5,
        date: 'Mon, 01 Jan 2026 10:00:00 GMT',
      },
    ]);
    const known = await core.rss.addFeed('https://subsplease.example/rss');
    const res = await core.rss.importQbRules(
      {
        'Astro Note': {
          enabled: true,
          mustContain: 'Astro Note 1080p',
          mustNotContain: '',
          useRegex: false,
          episodeFilter: '1x01-;',
          smartFilter: true,
          affectedFeeds: ['https://subsplease.example/rss', 'https://tosho.example/rss'],
          ignoreDays: 0,
          lastMatch: '08 Mar 2025 10:00:00 +0000',
          addPaused: null,
          assignedCategory: '',
          savePath: '',
          torrentParams: {
            category: 'Anime',
            save_path: '/downloads/6/Anime/Astro Note/S01',
            tags: ['auto'],
            stopped: false,
          },
        },
        Relative: { enabled: true, mustContain: 'x', savePath: 'Anime/X', affectedFeeds: [] },
        'Bad regex': { enabled: true, useRegex: true, mustContain: '(', affectedFeeds: [] },
      },
      { createMissingFeeds: true, applyToExisting: false },
    );
    expect(res).toMatchObject({ created: 2, updated: 0, feedsCreated: 1 });
    expect(res.errors).toEqual([{ name: 'Bad regex', error: expect.stringMatching(/regular/) }]);
    expect(res.warnings).toEqual([
      { name: 'Relative', warning: expect.stringMatching(/disabled/) },
    ]);

    const tosho = core.rss.feeds().find((f) => f.url === 'https://tosho.example/rss')!;
    const rules = core.rss.rules();
    expect(rules.find((r) => r.name === 'Astro Note')).toMatchObject({
      enabled: true,
      mustContain: ['Astro Note 1080p'],
      episodeFilter: '1x01-;',
      smartEpisodeFilter: true,
      assignedFeedIds: [known.id, tosho.id],
      category: 'Anime',
      tags: ['auto'],
      savePath: '/downloads/6/Anime/Astro Note/S01',
      addPaused: false,
      lastMatchAt: '2025-03-08T10:00:00.000Z',
    });
    expect(rules.find((r) => r.name === 'Relative')).toMatchObject({
      enabled: false,
      savePath: join(dir, 'd', 'Anime/X'),
    });
    // Existing articles are left alone unless asked.
    expect(core.torrents.list()).toHaveLength(0);

    const again = await core.rss.importQbRules(
      { 'Astro Note': { enabled: true, mustContain: 'Astro Note', affectedFeeds: [known.url] } },
      { createMissingFeeds: false, applyToExisting: true },
    );
    expect(again).toMatchObject({ created: 0, updated: 1, feedsCreated: 0 });
    expect(core.torrents.list().map((t) => t.savePath)).toEqual([join(dir, 'd')]);

    const ids = core.rss.rules().map((r) => r.id);
    expect(core.rss.deleteRules([...ids, ids[0]!, 'missing'])).toBe(2);
    expect(core.rss.rules()).toEqual([]);
  });

  it('adds and removes feeds on several rules, turning on disabled ones that get a feed', async () => {
    xml = feedXml([]);
    const a = await core.rss.addFeed('https://feeds.example/a');
    const b = await core.rss.addFeed('https://feeds.example/b');
    const base = {
      priority: 0,
      mustContain: [],
      mustNotContain: [],
      useRegex: false,
      smartEpisodeFilter: false,
      tags: [],
      addPaused: false,
    };
    const one = await core.rss.saveRule({
      ...base,
      name: 'One',
      enabled: false,
      assignedFeedIds: [],
    });
    const two = await core.rss.saveRule({
      ...base,
      name: 'Two',
      enabled: true,
      assignedFeedIds: [a.id],
    });
    const untouched = await core.rss.saveRule({
      ...base,
      name: 'Three',
      enabled: false,
      assignedFeedIds: [],
    });

    expect(
      await core.rss.setRuleFeeds({
        ids: [one.id, two.id],
        add: [b.id],
        remove: [a.id],
        enable: true,
        applyToExisting: false,
      }),
    ).toEqual({ updated: 2, enabled: 1 });
    const byName = new Map(core.rss.rules().map((r) => [r.name, r]));
    expect(byName.get('One')).toMatchObject({ enabled: true, assignedFeedIds: [b.id] });
    expect(byName.get('Two')).toMatchObject({ enabled: true, assignedFeedIds: [b.id] });
    expect(byName.get('Three')).toMatchObject({ enabled: false, assignedFeedIds: [] });
    expect(untouched.id).toBe(byName.get('Three')!.id);

    // Nothing to change: no writes.
    expect(
      await core.rss.setRuleFeeds({
        ids: [one.id],
        add: [b.id],
        remove: [],
        enable: true,
        applyToExisting: false,
      }),
    ).toEqual({ updated: 0, enabled: 0 });
    await expect(
      core.rss.setRuleFeeds({
        ids: [one.id],
        add: ['nope'],
        remove: [],
        enable: false,
        applyToExisting: false,
      }),
    ).rejects.toThrow(/Feed not found/);
  });

  it('edits feeds and rules as one JSON document', async () => {
    xml = feedXml([]);
    const a = await core.rss.addFeed('https://feeds.example/a');
    await core.rss.saveRule({
      name: 'Show',
      enabled: true,
      priority: 0,
      mustContain: ['show 720'],
      mustNotContain: [],
      useRegex: false,
      smartEpisodeFilter: false,
      assignedFeedIds: [a.id],
      tags: [],
      addPaused: false,
      savePath: '/media/Show/S01',
    });
    const parse = (c: unknown) => rssConfigSchema.parse(c);
    const cfg = core.rss.exportConfig();
    expect(cfg.rules[0]).toMatchObject({ name: 'Show', feeds: ['https://feeds.example/a'] });

    // Saving it unchanged writes nothing.
    expect(core.rss.importConfig(parse(cfg), false)).toEqual({
      feeds: { created: 0, updated: 0, deleted: 0 },
      rules: { created: 0, updated: 0, deleted: 0 },
    });

    // Rename by id, add a feed and a rule using it.
    const edited = structuredClone(cfg);
    edited.rules[0]!.name = 'Show (renamed)';
    edited.feeds.push({ url: 'https://feeds.example/b', title: 'B' });
    edited.rules.push({ name: 'Other', feeds: ['https://feeds.example/b'] });
    expect(core.rss.importConfig(parse(edited), false)).toEqual({
      feeds: { created: 1, updated: 0, deleted: 0 },
      rules: { created: 1, updated: 1, deleted: 0 },
    });
    const rules = core.rss.rules();
    expect(rules.map((r) => r.name).sort()).toEqual(['Other', 'Show (renamed)']);
    expect(core.rss.feeds().find((f) => f.url.endsWith('/b'))?.title).toBe('B');

    // Invalid documents change nothing.
    const bad = structuredClone(edited);
    bad.rules[1]!.feeds = ['https://feeds.example/unknown'];
    expect(() => core.rss.importConfig(parse(bad), false)).toThrow(/isn't in "feeds"/);
    const dup = structuredClone(edited);
    dup.rules.push({ name: 'Other' });
    expect(() => core.rss.importConfig(parse(dup), false)).toThrow(/same name/);
    expect(core.rss.rules()).toHaveLength(2);

    // removeMissing deletes what the document leaves out.
    expect(
      core.rss.importConfig(parse({ feeds: [edited.feeds[1]], rules: [edited.rules[1]] }), true),
    ).toEqual({
      feeds: { created: 0, updated: 0, deleted: 1 },
      rules: { created: 0, updated: 0, deleted: 1 },
    });
    expect(core.rss.rules().map((r) => r.name)).toEqual(['Other']);
  });
});
