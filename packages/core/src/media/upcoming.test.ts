import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCore, type Core } from '../core.ts';
import { FakeEngine } from '../testing/index.ts';
import { httpTransport } from '../net/http.ts';
import { proximityScore } from './upcoming.ts';

/** Serves the HTTP helper from a fetch-style stub instead of the network. */
function useFetchStub(stub: typeof fetch): void {
  vi.spyOn(httpTransport, 'request').mockImplementation(async (target, _addrs, req) => {
    const res = await stub(target, { method: req.method, headers: req.headers, body: req.body });
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body: Readable.from([Buffer.from(await res.arrayBuffer())]),
    };
  });
}

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const hash = (n: number) => n.toString(16).padStart(40, '0');

/** Routes stubbed fetch calls to fixture JSON by URL. */
function fakeFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (url.host === 'api.themoviedb.org') {
      const p = url.pathname.replace('/3', '');
      if (p === '/search/tv')
        return json({ results: [{ id: 63639, name: 'The Expanse', popularity: 50 }] });
      if (p === '/search/movie')
        return json({
          results: [{ id: 438631, title: 'Dune', release_date: '2021-09-15', popularity: 80 }],
        });
      if (p === '/tv/63639')
        return json({
          id: 63639,
          name: 'The Expanse',
          popularity: 50,
          seasons: [
            { season_number: 3, air_date: '2018-04-11' },
            { season_number: 4, air_date: '2019-12-12' },
            { season_number: 5, air_date: day(20) },
          ],
        });
      if (p === '/movie/438631')
        return json({
          id: 438631,
          title: 'Dune',
          belongs_to_collection: { id: 726871, name: 'Dune Collection' },
        });
      if (p === '/collection/726871')
        return json({
          id: 726871,
          name: 'Dune Collection',
          parts: [
            { id: 438631, title: 'Dune', release_date: '2021-09-15' },
            { id: 693134, title: 'Dune: Part Two', release_date: day(-10), popularity: 300 },
          ],
        });
      if (p === '/discover/movie')
        return json({
          results:
            url.searchParams.get('page') === '1' &&
            url.searchParams.get('primary_release_date.gte') === day(1)
              ? [{ id: 1, title: 'Big Upcoming Film', release_date: day(7), popularity: 500 }]
              : [],
        });
      if (p === '/discover/tv')
        return json({
          results: [{ id: 4, name: 'New Show', first_air_date: day(30), popularity: 60 }],
        });
      if (p === '/movie/now_playing')
        return json({
          results: [{ id: 2, title: 'Expanse Documentary', release_date: day(-3), popularity: 20 }],
        });
      if (p === '/tv/on_the_air')
        return json({
          results: [{ id: 3, name: 'Some Show', first_air_date: '2020-01-01', popularity: 100 }],
        });
    }
    if (url.host === 'graphql.anilist.co') {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      const frieren = {
        id: 154587,
        title: { english: "Frieren: Beyond Journey's End", romaji: 'Sousou no Frieren' },
        synonyms: ['Frieren'],
        status: 'FINISHED',
        popularity: 400000,
      };
      if (body.variables.q) return json({ data: { Page: { media: [frieren] } } });
      if (body.variables.id)
        return json({
          data: {
            Media: {
              ...frieren,
              relations: {
                edges: [
                  {
                    relationType: 'SEQUEL',
                    node: {
                      id: 182255,
                      title: { english: 'Frieren Season 2' },
                      status: 'NOT_YET_RELEASED',
                      startDate: { year: 2027, month: 9 },
                      popularity: 90000,
                    },
                  },
                  {
                    relationType: 'PREQUEL',
                    node: { id: 5, title: { english: 'Prequel' }, status: 'FINISHED' },
                  },
                ],
              },
            },
          },
        });
      return json({
        data: {
          Page: {
            media: [
              {
                id: 999,
                title: { romaji: 'Airing Anime' },
                status: body.variables.status,
                popularity: 1000,
              },
            ],
          },
        },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

let dir: string;
let core: Core;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'draxmax-upcoming-'));
  useFetchStub(fakeFetch());
  core = createCore({
    configPath: join(dir, 'c'),
    downloadPath: join(dir, 'd'),
    engine: new FakeEngine(),
    env: {},
    noSchedulers: true,
  });
  core.torrents.addMagnet(`magnet:?xt=urn:btih:${hash(1)}&dn=The.Expanse.S03E05.1080p.WEB`);
  core.torrents.addMagnet(`magnet:?xt=urn:btih:${hash(2)}&dn=Dune.2021.2160p.UHD.BluRay`);
  core.torrents.addMagnet(
    `magnet:?xt=urn:btih:${hash(3)}&dn=%5BSubsPlease%5D%20Frieren%20-%2028%20(1080p)`,
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await core.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('UpcomingService', () => {
  it('builds the library fingerprint from torrent names', async () => {
    const lib = await core.upcoming.rescanLibrary();
    expect(lib.map((e) => [e.type, e.title, e.seasonsOwned, e.year])).toEqual([
      ['movie', 'Dune', [], 2021],
      ['anime', 'Frieren', [1], null],
      ['tv', 'The Expanse', [3], null],
    ]);
  });

  it('ranks next seasons, collection entries and sequels in For You', async () => {
    core.settings.update({ tmdbApiKey: 'test-key' });
    await core.upcoming.refresh();
    const res = core.upcoming.get();
    expect(res.errors).toEqual([]);
    expect(res.forYou.map((i) => i.id)).toEqual([
      'tmdb-tv-63639-s4', // next season, released: 100 + 0
      'anilist-182255', // sequel, ~a year out: 95
      'tmdb-tv-63639-s5', // later season, premieres in 20 days: 80 + 12
      'tmdb-movie-693134', // collection part released 10 days ago: 70 + 15
    ]);
    expect(res.forYou[0]).toMatchObject({
      season: 4,
      status: 'released',
      matchedLibraryEntries: ['tv:the expanse'],
    });
    expect(res.forYou.find((i) => i.id === 'tmdb-movie-693134')?.reason).toMatch(/Dune Collection/);

    // New Releases: popularity + proximity, with a boost for library resemblance.
    expect(res.newReleases.map((i) => i.id)).toContain('tmdb-movie-1');
    expect(res.newReleases.map((i) => i.id)).toContain('anilist-999');
    // Shows that haven't premiered are upcoming; ones on the air are airing.
    expect(res.newReleases.find((i) => i.id === 'tmdb-tv-4')?.status).toBe('upcoming');
    expect(res.newReleases.find((i) => i.id === 'tmdb-tv-3')?.status).toBe('airing');
    expect(res.library).toEqual({ total: 3, pending: 0 });
  });

  it('reads media folders by structure: one title per show, never per episode', async () => {
    const media = join(dir, 'media');
    const touch = (...parts: string[]) => {
      mkdirSync(join(media, ...parts.slice(0, -1)), { recursive: true });
      writeFileSync(join(media, ...parts), '');
    };
    touch('Anime', 'Fate Apocrypha', 'S01', '08 - Beacon Of War.mkv');
    touch('Anime', 'A Will Eternal', 'S01', '[Hall_of_C] Yi_Nian_Yong_Heng_AWE_47.mkv');
    touch('Anime', 'A Will Eternal', 'S02', '[Hall_of_C] Yi_Nian_Yong_Heng_AWE_60.mkv');
    touch('Anime', 'Gleipnir', '[HorribleSubs] Gleipnir - 10 [720p].mkv');
    touch('TV', 'Universe.2021', 'S01', 'Universe.S01E03.NORDiC.1080p.WEB-DL.H.264-GRP.mkv');
    touch('TV', 'Mountain Monsters', 'Season 6', 'Mountain Monsters S06E10 The Twisted Torch.mkv');
    touch('TV', 'Subbed Show', 'S01', '[Group] Subbed Show - 01 [720p].mkv');
    touch('Movies', 'Barb.Wire.1996.UNRATED.1080p.BluRay.x264-GRP', 'grp-barbwire1080.mkv');
    touch('Movies', 'Tropic.Thunder.2008.2160p.WEB.H265-GRP.mkv');
    core.settings.update({ libraryFolders: [media] });

    const lib = (await core.upcoming.rescanLibrary()).filter((e) => e.source === 'folder');
    expect(lib.map((e) => [e.type, e.title, e.seasonsOwned, e.year])).toEqual([
      ['anime', 'A Will Eternal', [1, 2], null],
      ['movie', 'Barb Wire', [], 1996],
      ['anime', 'Fate Apocrypha', [1], null],
      ['anime', 'Gleipnir', [1], null],
      ['tv', 'Mountain Monsters', [6], null],
      ['anime', 'Subbed Show', [1], null],
      ['movie', 'Tropic Thunder', [], 2008],
      ['tv', 'Universe', [1], 2021],
    ]);
  });

  it('checks the whole library for For You, not just its first entries', async () => {
    // Plenty of unmatched titles sorting ahead of the ones that have something new.
    for (let n = 0; n < 80; n++) core.upcoming.library.addManual(`Aaa Filler ${n}`, 'other');
    core.settings.update({ tmdbApiKey: 'test-key' });
    await core.upcoming.refresh();
    expect(core.upcoming.get().forYou.map((i) => i.id)).toEqual([
      'tmdb-tv-63639-s4',
      'anilist-182255',
      'tmdb-tv-63639-s5',
      'tmdb-movie-693134',
    ]);
  });

  it('treats two library names for one show as the same show', async () => {
    core.upcoming.library.addManual('Expanse', 'tv', [4]);
    core.settings.update({ tmdbApiKey: 'test-key' });
    await core.upcoming.refresh();
    const ids = core.upcoming.get().forYou.map((i) => i.id);
    expect(ids).toContain('tmdb-tv-63639-s5');
    expect(ids).not.toContain('tmdb-tv-63639-s4');
  });

  it('waits out an AniList rate limit instead of giving up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const real = fakeFetch();
    let limited = 0;
    useFetchStub((async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes('anilist') && limited++ === 0)
        return new Response('slow down', { status: 429, headers: { 'retry-after': '30' } });
      return real(input, init);
    }) as typeof fetch);
    let done = false;
    const refresh = core.upcoming.refresh().finally(() => (done = true));
    let waited = 0;
    while (!done) {
      await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(1000);
      waited += 1000;
    }
    await refresh;
    vi.useRealTimers();
    expect(waited).toBeGreaterThanOrEqual(30_000);
    const res = core.upcoming.get();
    expect(res.errors).toEqual([]);
    expect(res.forYou.map((i) => i.id)).toEqual(['anilist-182255']);
  });

  it('only announces For You items that are news, not a library being linked', async () => {
    const announced: string[] = [];
    core.events.on('upcoming:new', (items) => announced.push(...items.map((i) => i.id)));
    await core.upcoming.refresh(); // AniList only: records the baseline
    core.settings.update({ tmdbApiKey: 'test-key' });
    await core.upcoming.refresh(); // links the TMDB titles: a catch-up, not news
    expect(core.upcoming.get().forYou).toHaveLength(4);
    expect(announced).toEqual([]);
  });

  it('skips sequels of anime seasons already owned', async () => {
    // AniList has one entry per season: 10 → 11 → 12 (announced).
    const season = (id: number, status: string, sequel?: object) => ({
      id,
      title: { romaji: `Chain Show ${id}` },
      format: 'TV',
      status,
      relations: { edges: sequel ? [{ relationType: 'SEQUEL', node: sequel }] : [] },
    });
    const s12 = season(12, 'NOT_YET_RELEASED');
    const s11 = season(11, 'FINISHED', s12);
    const chain = new Map(
      [10, 11, 12].map((id, n) => [id, [season(10, 'FINISHED', s11), s11, s12][n]]),
    );
    useFetchStub((async (_input: string | URL, init?: RequestInit) => {
      const { variables } = JSON.parse(String(init?.body)) as { variables: { id?: number } };
      const data = variables.id ? { Media: chain.get(variables.id) } : { Page: { media: [] } };
      return new Response(JSON.stringify({ data }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch);
    core.upcoming.library.addManual('Chain Show', 'anime', [1, 2], null, { anilistId: 10 });
    await core.upcoming.refresh();
    const res = core.upcoming.get();
    expect(res.errors).toEqual([]);
    // Season 2 is on disk, so only the announced third season is offered.
    expect(res.forYou.map((i) => [i.id, i.reason])).toEqual([
      ['anilist-12', 'Sequel to Chain Show 11'],
    ]);
  });

  it('ignore hides an item; already-have records it and hides it', async () => {
    core.settings.update({ tmdbApiKey: 'test-key' });
    await core.upcoming.refresh();
    core.upcoming.act('tmdb-tv-63639-s5', 'ignore');
    let ids = core.upcoming.get().forYou.map((i) => i.id);
    expect(ids).not.toContain('tmdb-tv-63639-s5');

    core.upcoming.act('tmdb-tv-63639-s4', 'have');
    ids = core.upcoming.get().forYou.map((i) => i.id);
    expect(ids).not.toContain('tmdb-tv-63639-s4');
    const expanse = core.upcoming.library.all().find((e) => e.id === 'tv:the expanse');
    expect(expanse?.seasonsOwned).toEqual([3, 4]);

    core.upcoming.act('tmdb-tv-63639-s5', 'reset');
    expect(core.upcoming.get().forYou.map((i) => i.id)).toContain('tmdb-tv-63639-s5');
  });

  it('works with AniList only (no TMDB key) and reports source errors', async () => {
    useFetchStub((async (input: string | URL) => {
      if (String(input).includes('anilist')) return new Response('down', { status: 500 });
      return new Response('{}', { status: 404 });
    }) as typeof fetch);
    await core.upcoming.refresh();
    const res = core.upcoming.get();
    expect(res.sources).toEqual({ tmdb: false, anilist: true });
    expect(res.errors.join()).toMatch(/AniList: HTTP 500/);
  });

  it('proximity score favours imminent and fresh releases', () => {
    expect(proximityScore(day(5))).toBe(20);
    expect(proximityScore(day(40))).toBe(12);
    expect(proximityScore(day(-10))).toBe(15);
    expect(proximityScore(day(-400))).toBe(0);
    expect(proximityScore(undefined)).toBe(0);
  });
});
