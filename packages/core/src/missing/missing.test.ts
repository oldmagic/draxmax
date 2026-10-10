import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuleInput } from '@draxmax/shared';
import { createCore, type Core } from '../core.ts';
import { FakeEngine } from '../testing/index.ts';
import { inferIdentity, planDownloads, searchQuery, type Identity } from './plan.ts';
import type { SearchResult } from './sources.ts';

const hash = (n: number) => n.toString(16).padStart(40, '0');
const result = (title: string, seeders: number | null = 10, n = 1): SearchResult => ({
  title,
  url: `magnet:?xt=urn:btih:${hash(n)}`,
  seeders,
  size: null,
  source: 'test',
});
const rule = {
  mustContain: ['Sousou no Frieren S2 720'],
  mustNotContain: [],
  useRegex: false,
};
const frieren2: Identity = {
  key: 'sousou no frieren',
  title: 'Sousou no Frieren',
  season: 2,
  anime: true,
};

describe('missing-episode planning', () => {
  it('infers the show and season a folder holds', () => {
    expect(
      inferIdentity([
        '[SubsPlease] Sousou no Frieren S2 - 01 (720p) [AAAA].mkv',
        '[SubsPlease] Sousou no Frieren S2 - 02 (720p) [BBBB].mkv',
        'Some Movie (2020).mkv',
      ]),
    ).toEqual(frieren2);
    expect(inferIdentity(['notes.txt'])).toBeNull();
  });

  it('builds the search text from the rule, dropping wildcards and bare resolutions', () => {
    expect(searchQuery(rule, frieren2)).toBe('Sousou no Frieren S2');
    expect(searchQuery({ mustContain: ['Show* 1080p|Other'], useRegex: false }, frieren2)).toBe(
      'Show',
    );
    expect(
      searchQuery(
        { mustContain: ['Monarch.*S02E[0-9]{2}'], useRegex: true },
        { key: 'monarch', title: 'Monarch', season: 2, anime: false },
      ),
    ).toBe('Monarch S02');
  });

  it('picks gaps and newer episodes that pass the rule, never earlier or other seasons', () => {
    const results = [
      result('[SubsPlease] Sousou no Frieren S2 - 01 (720p) [X].mkv', 50, 1), // before first owned
      result('[SubsPlease] Sousou no Frieren S2 - 03 (720p) [X].mkv', 5, 3), // gap
      result('[SubsPlease] Sousou no Frieren S2 - 03 (1080p) [X].mkv', 99, 30), // wrong quality
      result('[SubsPlease] Sousou no Frieren S2 - 05 (720p) [X].mkv', 0, 5), // no seeders
      result('[Erai-raws] Sousou no Frieren S2 - 06 [720p][Multiple Subtitle]', 4, 6), // newer
      result('[SubsPlease] Sousou no Frieren S2 - 06 (720p) [X].mkv', 20, 60), // better copy
      result('[SubsPlease] Sousou no Frieren - 07 (720p) [X].mkv', 20, 7), // season 1 numbering
    ];
    const plan = planDownloads(results, rule, frieren2, new Set([2, 4]), { minSeeders: 1 });
    expect(plan.released).toEqual([3, 5, 6]);
    expect(plan.missing).toEqual([3, 5, 6]);
    expect(plan.downloads.map((d) => [d.episodes, d.result.seeders])).toEqual([
      [[3], 5],
      [[6], 20],
    ]);
    expect(plan.unavailable).toEqual([5]);
  });

  it('takes a batch only when every episode in it is missing', () => {
    const results = [
      result('[SubsPlease] Sousou no Frieren S2 - 01-04 (720p) [Batch]', 30, 1),
      result('[SubsPlease] Sousou no Frieren S2 - 03 (720p)', 10, 3),
      result('[SubsPlease] Sousou no Frieren S2 - 04 (720p)', 10, 4),
    ];
    const some = planDownloads(results, rule, frieren2, new Set([1, 2]), { minSeeders: 1 });
    expect(some.downloads.map((d) => d.episodes)).toEqual([[3], [4]]);
    const none = planDownloads(results, rule, frieren2, new Set([]), { minSeeders: 1 });
    expect(none.downloads.map((d) => d.episodes)).toEqual([[1, 2, 3, 4]]);
  });
});

describe('MissingService', () => {
  let dir: string;
  let core: Core;
  let show: string;
  const fetchText = vi.fn(async (url: string) => {
    if (url.startsWith('https://nyaa.si/'))
      return `<?xml version="1.0"?><rss version="2.0" xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel><title>Nyaa</title>
${[1, 2, 3, 4, 5]
  .map(
    (
      e,
    ) => `<item><title>[SubsPlease] Chii Fuyo - 0${e} (720p) [ABC${e}].mkv</title><guid>g${e}</guid>
<link>https://nyaa.si/view/${e}</link><nyaa:infoHash>${hash(e)}</nyaa:infoHash><nyaa:seeders>${e === 5 ? 0 : 12}</nyaa:seeders></item>`,
  )
  .join('\n')}</channel></rss>`;
    return JSON.stringify([
      {
        title: '[SubsPlease] Chii Fuyo - 04 (720p) [ABC4].mkv',
        info_hash: hash(4),
        seeders: 40,
        total_size: 1,
      },
    ]);
  });

  const input = (savePath: string): RuleInput => ({
    name: 'Chii Fuyo',
    enabled: true,
    priority: 0,
    mustContain: ['Chii Fuyo 720'],
    mustNotContain: [],
    useRegex: false,
    smartEpisodeFilter: false,
    assignedFeedIds: [],
    tags: [],
    addPaused: false,
    savePath,
  });

  beforeEach(() => {
    fetchText.mockClear();
    dir = mkdtempSync(join(tmpdir(), 'draxmax-missing-'));
    show = join(dir, 'Anime', 'Chii Fuyo', 'S01');
    mkdirSync(show, { recursive: true });
    core = createCore({
      configPath: join(dir, 'c'),
      downloadPath: join(dir, 'd'),
      engine: new FakeEngine(),
      env: {},
      noSchedulers: true,
      missingFetch: { fetchText },
    });
  });
  afterEach(async () => {
    await core.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds released episodes the folder lacks into the rule folder, once', async () => {
    writeFileSync(join(show, '[SubsPlease] Chii Fuyo - 01 (720p) [ABC1].mkv'), '');
    writeFileSync(join(show, '[SubsPlease] Chii Fuyo - 03 (720p) [ABC3].mkv'), '');
    await core.rss.saveRule(input(show));

    await core.missing.run({ force: true });
    const s = core.missing.get();
    expect(s.sources).toEqual(['Nyaa', 'AnimeTosho']);
    expect(s.shows[0]).toMatchObject({
      title: 'Chii Fuyo',
      season: 1,
      have: [1, 3],
      missing: [2, 4, 5],
      added: [2, 4],
      unavailable: [5],
      state: 'missing',
    });
    const added = core.torrents.list();
    expect(added.map((t) => t.infoHash).sort()).toEqual([hash(2), hash(4)]);
    expect(added.every((t) => t.savePath === show)).toBe(true);
    expect(core.rss.history().map((h) => h.feedId)).toEqual(['missing', 'missing']);

    // Episodes in the client (or downloaded before) aren't added again.
    await core.missing.run({ force: true });
    expect(core.torrents.list()).toHaveLength(2);
    expect(core.missing.get().shows[0]).toMatchObject({ have: [1, 2, 3, 4], added: [] });
  });

  it('skips empty folders and runs only when enabled unless forced', async () => {
    await core.rss.saveRule(input(show));
    core.settings.update({ missingEnabled: false });
    await core.missing.run();
    expect(core.missing.get().shows[0]!.state).toBe('pending');
    await core.missing.run({ force: true });
    expect(core.missing.get().shows[0]!.state).toBe('empty');
    expect(fetchText).not.toHaveBeenCalled();
  });

  it('fetches the season from episode 1 for an empty folder when asked to, per rule or globally', async () => {
    const saved = await core.rss.saveRule(input(show));
    await core.missing.run({ force: true });
    expect(core.missing.get().shows[0]!.state).toBe('empty');
    expect(core.missing.get().whenEmpty).toBe('wait');

    // Global setting: empty folders start from episode 1 (the show is named by the results).
    core.settings.update({ missingWhenEmpty: 'download' });
    await core.missing.run({ force: true });
    expect(core.missing.get().shows[0]).toMatchObject({
      title: 'Chii Fuyo',
      have: [],
      added: [1, 2, 3, 4],
      unavailable: [5],
    });
    expect(core.torrents.list()).toHaveLength(4);

    // A rule can opt out entirely, and is then not listed at all.
    await core.rss.saveRule({ ...input(show), missingMode: 'off' }, saved.id);
    expect(core.missing.get().shows).toEqual([]);
  });

  it('"whole season" also fetches episodes before the first one owned', async () => {
    writeFileSync(join(show, '[SubsPlease] Chii Fuyo - 03 (720p) [ABC3].mkv'), '');
    const saved = await core.rss.saveRule({ ...input(show), missingMode: 'gaps' });
    core.settings.update({ missingWhenEmpty: 'download' });
    await core.missing.run({ force: true });
    expect(core.missing.get().shows[0]).toMatchObject({ have: [3], added: [4] });

    await core.rss.saveRule({ ...input(show), missingMode: 'all' }, saved.id);
    await core.missing.run({ force: true });
    expect(core.missing.get().shows[0]).toMatchObject({ added: [1, 2] });
  });

  it('counts enabled rules that have no folder, and asks only sources that carry the kind', async () => {
    await core.rss.saveRule({ ...input(show), savePath: undefined });
    expect(core.missing.get()).toMatchObject({ shows: [], noFolder: 1 });

    writeFileSync(join(show, 'Chii.Fuyo.S01E01.720p.WEB.x264-GRP.mkv'), '');
    await core.rss.saveRule({ ...input(show), name: 'Live action' });
    core.sites.saveSite({
      name: 'Movies only',
      baseUrls: ['https://movies.example/'],
      searchUrls: ['/s?q={query}'],
      contentTypes: ['movies'],
    });
    await core.missing.run({ force: true });
    // Live action: the anime indexers and the movies-only site are all left alone.
    expect(fetchText).not.toHaveBeenCalled();
    expect(core.missing.get().shows[0]).toMatchObject({ state: 'error' });
    expect(core.missing.get().shows[0]!.message).toMatch(/Torznab|carries TV/);
  });

  it('searches from the UI, hands out handles instead of links, and adds by handle', async () => {
    const res = await core.search.search('Chii Fuyo', 'anime');
    expect(res.searched).toEqual(['Nyaa', 'AnimeTosho']);
    expect(res.results[0]).toMatchObject({
      show: 'Chii Fuyo',
      episodes: [4],
      seeders: 40,
      inList: false,
    });
    expect(JSON.stringify(res)).not.toContain('magnet:');
    const added = await core.search.add(res.results[0]!.id, { category: 'Anime' });
    expect(added).toMatchObject({ infoHash: hash(4), category: 'Anime' });
    await expect(core.search.add('nope', {})).rejects.toThrow(/expired/);
    expect(
      (await core.search.search('Chii Fuyo')).results.find((r) => r.episodes[0] === 4)!.inList,
    ).toBe(true);
    // Movies: no anime-only source is asked.
    expect((await core.search.search('Dune', 'movies')).searched).toEqual([]);
  });

  it('manages built-in and Torznab sources without exposing API keys', () => {
    core.search.addTorznab('http://prowlarr.lan:9696/1/api?apikey=SECRETKEY');
    expect(() => core.search.addTorznab('http://prowlarr.lan:9696/1/api?apikey=SECRETKEY')).toThrow(
      /already/,
    );
    core.search.setBuiltinEnabled('nyaa', false);
    const list = core.search.sourceList();
    expect(list.map((x) => [x.id, x.enabled])).toEqual([
      ['nyaa', false],
      ['animetosho', true],
      ['torznab:0', true],
    ]);
    expect(JSON.stringify(list)).not.toContain('SECRETKEY');
    core.search.removeTorznab(0);
    expect(core.search.sourceList()).toHaveLength(2);
  });

  it('suggests a rule from a release name, modelled on existing rules', async () => {
    await core.rss.saveRule({ ...input(show), category: 'Anime', tags: ['auto'] });
    const draft = core.rss.suggestRule(
      '[SubsPlease] Kaoru Hana wa Rin to Saku - 05 (1080p) [ABCD].mkv',
    );
    expect(draft).toMatchObject({
      name: 'Kaoru Hana wa Rin to Saku',
      mustContain: ['Kaoru Hana wa Rin to Saku SubsPlease 1080p'],
      savePath: join(dir, 'Anime', 'Kaoru Hana wa Rin to Saku', 'S01'),
      category: 'Anime',
      tags: ['auto'],
      smartEpisodeFilter: true,
    });
  });
});
