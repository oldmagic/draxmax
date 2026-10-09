import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuleInput, SiteInput } from '@draxmax/shared';
import { createCore, type Core } from '../core.ts';
import { FakeEngine, makeTorrentFile } from '../testing/index.ts';
import { parseSearch, parseSize } from './parse.ts';
import { normalizeCookies, parseHeaders } from './site-service.ts';
import { fill, redactSecrets, templateToRegex, TemplateError } from './templates.ts';

describe('templates', () => {
  it('fills placeholders with URL-encoded values and names missing ones', () => {
    expect(
      fill('/search?q={query}&pk={passkey}', { query: 'Show S01 & more', passkey: 'a/b' }),
    ).toBe('/search?q=Show%20S01%20%26%20more&pk=a%2Fb');
    expect(() => fill('/download.php?id={id}&passkey={passkey}', { id: 1 })).toThrow(TemplateError);
    expect(() => fill('/x?{a}{b}', {})).toThrow('No value for {a}, {b}');
  });

  it('turns torrent-page patterns into link matchers', () => {
    const sb = templateToRegex('/torrent/{id}/')!;
    expect(sb.exec('/torrent/2825996/')?.groups?.id).toBe('2825996');
    expect(sb.exec('https://superbits.org/torrent/12')?.groups?.id).toBe('12');
    const q = templateToRegex('/torrents.php?id={groupId}&torrentid={id}')!;
    expect(q.exec('torrents.php?id=5&amp;torrentid=77')?.groups?.id).toBe('77');
    expect(
      templateToRegex('https://x.org/details.php?id={id}')!.exec('/details.php?id=9')?.groups?.id,
    ).toBe('9');
    expect(sb.exec('/forum/viewtorrent/5/')).toBeNull();
    expect(templateToRegex('/no-id')).toBeNull();
  });

  it('masks secrets and parses sizes, cookies and headers', () => {
    expect(redactSecrets('passkey=abcd1234&x', ['abcd1234'])).toBe('passkey=•••&x');
    expect(parseSize('1.5 GiB')).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseSize('700 MB')).toBe(700e6);
    expect(normalizeCookies('Cookie: uid=1; pass=abc')).toBe('uid=1; pass=abc');
    expect(normalizeCookies('uid=1\npass=abc\njunk')).toBe('uid=1; pass=abc');
    expect(parseHeaders('Authorization: Bearer x\nX-Api-Key: y')).toEqual({
      Authorization: 'Bearer x',
      'X-Api-Key': 'y',
    });
    expect(() => parseHeaders('Host: evil')).toThrow(/can't be set/);
  });
});

describe('search response parsing', () => {
  it('detects JSON result lists and their fields', async () => {
    const body = JSON.stringify({
      status: 'ok',
      data: {
        total: 2,
        torrents: [
          { id: 11, name: 'Show.S01E01.1080p.WEB-GRP', seeders: '12', size: 1234567 },
          { id: 12, name: 'Show.S01E02.1080p.WEB-GRP', seeders: 3, size: '1.2 GB' },
        ],
      },
    });
    const r = await parseSearch(body, 'application/json', {
      infoUrl: '',
      mapping: { format: 'auto' },
    });
    expect(r.format).toBe('json');
    expect(r.mapping).toMatchObject({
      list: 'data.torrents',
      title: 'name',
      id: 'id',
      seeders: 'seeders',
      size: 'size',
    });
    expect(r.hits).toEqual([
      {
        title: 'Show.S01E01.1080p.WEB-GRP',
        id: '11',
        groupId: null,
        link: null,
        seeders: 12,
        size: 1234567,
      },
      {
        title: 'Show.S01E02.1080p.WEB-GRP',
        id: '12',
        groupId: null,
        link: null,
        seeders: 3,
        size: 1.2e9,
      },
    ]);
    // Configured paths win over detection.
    const mapped = await parseSearch(
      JSON.stringify({ rows: [{ t: 'A', key: 'x1', dl: '/dl/x1' }] }),
      '',
      {
        infoUrl: '',
        mapping: { format: 'json', list: 'rows', title: 't', id: 'key', download: 'dl' },
      },
    );
    expect(mapped.hits[0]).toMatchObject({ title: 'A', id: 'x1', link: '/dl/x1' });
  });

  it('reads HTML search pages by the torrent-page link pattern', async () => {
    const html = `<html><body><table>
      <tr><td><a href="/torrent/101/" title="Show.S01E01.720p">Show.S01E01.720p</a></td>
          <td class="seeders">15</td><td>1.40 GiB</td>
          <td><a href="/download.php?id=101&amp;passkey=x">DL</a></td></tr>
      <tr><td><a href="https://superbits.org/torrent/102/"><img src="x.png"></a>
          <a href="/torrent/102/">Show &amp; Tell S01E02</a></td><td title="Seeders">4</td></tr>
      <tr><td><a href="/forum/1">Not a torrent</a></td></tr>
    </table></body></html>`;
    const r = await parseSearch(html, 'text/html', {
      infoUrl: '/torrent/{id}/',
      mapping: { format: 'auto' },
    });
    expect(r.format).toBe('html');
    expect(r.hits.map((h) => [h.id, h.title, h.seeders])).toEqual([
      ['101', 'Show.S01E01.720p', 15],
      ['102', 'Show & Tell S01E02', 4],
    ]);
    expect(r.hits[0]!.size).toBe(Math.round(1.4 * 1024 ** 3));
    expect(r.hits[0]!.link).toBe('/download.php?id=101&passkey=x');
  });

  it('reads RSS / Torznab responses', async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>t</title>
      <item><title>Show S01E03</title><guid>g</guid><link>https://t.example/dl/3.torrent</link>
      <torznab:attr name="seeders" value="9"/></item></channel></rss>`;
    const r = await parseSearch(xml, 'application/rss+xml', {
      infoUrl: '',
      mapping: { format: 'auto' },
    });
    expect(r.format).toBe('rss');
    expect(r.hits[0]).toMatchObject({
      title: 'Show S01E03',
      link: 'https://t.example/dl/3.torrent',
      seeders: 9,
    });
  });
});

describe('SiteService', () => {
  let dir: string;
  let core: Core;
  const pages = new Map<string, { body: string; contentType: string; status?: number }>();
  const siteFetch = vi.fn(async (url: string, headers: Record<string, string>) => {
    const p = pages.get(new URL(url).pathname);
    void headers;
    return p
      ? { body: p.body, contentType: p.contentType, status: p.status ?? 200 }
      : { body: 'not found', contentType: 'text/plain', status: 404 };
  });
  const fetchTorrent = vi.fn(async () =>
    makeTorrentFile('Show S01E02', [{ path: ['e2.mkv'], length: 10 }]),
  );

  const superbits = (extra: Partial<SiteInput> = {}): SiteInput => ({
    name: 'SuperBits',
    preset: 'superbits',
    baseUrls: ['https://superbits.org/'],
    searchUrls: ['/api/v1/torrents?searchText={query}', '/search?search={query}'],
    infoUrl: '/torrent/{id}/',
    downloadUrl: '/download.php?id={id}&passkey={passkey}',
    fields: [{ name: 'passkey', label: 'Passkey' }],
    values: { passkey: 'PASSKEY123' },
    cookies: 'Cookie: sbid=SESSION999; theme=dark',
    ...extra,
  });

  beforeEach(() => {
    pages.clear();
    siteFetch.mockClear();
    fetchTorrent.mockClear();
    dir = mkdtempSync(join(tmpdir(), 'draxmax-sites-'));
    core = createCore({
      configPath: join(dir, 'c'),
      downloadPath: join(dir, 'd'),
      engine: new FakeEngine(),
      env: {},
      noSchedulers: true,
      siteFetch,
      missingFetch: { fetchText: async () => '[]', fetchTorrent },
    });
    core.settings.update({ missingUseNyaa: false, missingUseAnimeTosho: false });
  });
  afterEach(async () => {
    await core.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores credentials encrypted and only reports which are set', () => {
    const site = core.sites.saveSite(superbits());
    expect(site.secretsSet).toEqual({ values: { passkey: true }, cookies: 2, headers: 0 });
    expect(JSON.stringify(site)).not.toMatch(/PASSKEY123|SESSION999/);
    const raw = core.db.prepare('SELECT secrets FROM sites').get() as { secrets: string };
    expect(raw.secrets).toMatch(/^enc:/);
    expect(raw.secrets).not.toMatch(/PASSKEY123|SESSION999/);
    // Omitted secrets are kept, null clears.
    const kept = core.sites.saveSite(
      { ...superbits(), values: undefined, cookies: undefined },
      site.id,
    );
    expect(kept.secretsSet.values.passkey).toBe(true);
    expect(core.sites.saveSite({ ...superbits(), cookies: null }, site.id).secretsSet.cookies).toBe(
      0,
    );
  });

  it('refuses templates that point at other hosts', () => {
    expect(() =>
      core.sites.saveSite(superbits({ downloadUrl: 'https://evil.example/x?pk={passkey}' })),
    ).toThrow(/not on this site/);
  });

  it('tests searches, falling back to the next URL, with secrets masked', async () => {
    pages.set('/api/v1/torrents', {
      body: '<html><form><input type="password"></form></html>',
      contentType: 'text/html',
    });
    pages.set('/search', {
      body: '<table><tr><td><a href="/torrent/2825996/">Show.S01E02.1080p</a></td><td class="seed">8</td></tr></table>',
      contentType: 'text/html; charset=utf-8',
    });
    const site = core.sites.saveSite(superbits());
    const res = await core.sites.test(site.id, 'Show S01');
    expect(res).toMatchObject({ ok: true, format: 'html', total: 1, error: null });
    expect(res.results[0]).toEqual({
      title: 'Show.S01E02.1080p',
      id: '2825996',
      seeders: 8,
      size: null,
      downloadUrl: 'https://superbits.org/download.php?id=2825996&passkey=•••',
      filtered: 'ok',
    });
    // Cookies went to the site; the passkey never appears in the stored result.
    expect(siteFetch.mock.calls[0]![1]).toMatchObject({ cookie: 'sbid=SESSION999; theme=dark' });
    expect(JSON.stringify(core.sites.get(site.id).lastTest)).not.toMatch(/PASSKEY123|SESSION999/);
  });

  it('feeds missing-episode search and downloads with the site cookies', async () => {
    pages.set('/api/v1/torrents', {
      body: JSON.stringify({
        torrents: [{ id: 7, name: '[SubsPlease] Chii Fuyo - 02 (720p) [AA].mkv', seeders: 30 }],
      }),
      contentType: 'application/json',
    });
    core.sites.saveSite(superbits());
    expect(core.sites.headersFor('https://superbits.org/rss.php')).toEqual({
      cookie: 'sbid=SESSION999; theme=dark',
    });
    expect(core.sites.headersFor('https://other.example/')).toEqual({});

    const show = join(dir, 'Anime', 'Chii Fuyo', 'S01');
    mkdirSync(show, { recursive: true });
    writeFileSync(join(show, '[SubsPlease] Chii Fuyo - 01 (720p) [AA].mkv'), '');
    const rule: RuleInput = {
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
      savePath: show,
    };
    await core.rss.saveRule(rule);
    await core.missing.run({ force: true });

    expect(core.missing.get().sources).toContain('Site: SuperBits');
    expect(core.missing.get().shows[0]).toMatchObject({ added: [2] });
    expect(fetchTorrent).toHaveBeenCalledWith(
      'https://superbits.org/download.php?id=7&passkey=PASSKEY123',
      {
        allowPrivate: true,
        headers: { cookie: 'sbid=SESSION999; theme=dark' },
      },
    );
  });

  it('applies per-site release filters to tests and searches', async () => {
    const names = [
      'Spider-Man.Brand.New.Day.2026.NORDiC.1080p.UHDRip.x264-EGEN',
      'Spider-Man.Brand.New.Day.2026.REPACK.NORDiC.1080p.AMZN.WEB-DL.H.264-NORViNE',
      'Spider-Man.Brand.New.Day.2026.NORDiC.1080p.WEB.x264-OTHER',
      'Spider-Man.Brand.New.Day.2026.NORDiC.HDCAM.x264-EGEN',
    ];
    pages.set('/api/v1/torrents', {
      body: JSON.stringify({ torrents: names.map((name, i) => ({ id: i + 1, name, seeders: 5 })) }),
      contentType: 'application/json',
    });
    expect(() => core.sites.saveSite(superbits({ mustMatch: ['(oops'] }))).toThrow(
      /Must match: Invalid regular expression/,
    );
    const site = core.sites.saveSite(
      superbits({ mustMatch: ['-(EGEN|NORViNE)$', ''], mustNotMatch: ['\\b(HD)?CAM\\b'] }),
    );
    expect(site).toMatchObject({
      mustMatch: ['-(EGEN|NORViNE)$'],
      mustNotMatch: ['\\b(HD)?CAM\\b'],
    });

    const res = await core.sites.test(site.id, 'Spider-Man');
    expect(res.results.map((r) => r.filtered)).toEqual(['ok', 'ok', 'not-matched', 'excluded']);
    expect(res.error).toBe("2 of 4 results pass this site's release filters");

    const found = await core.sites.sources()[0]!.search('Spider-Man');
    expect(found.map((r) => r.title)).toEqual(names.slice(0, 2));
  });

  it('ships presets from the autobrr definitions', () => {
    const sb = core.sites.presets().find((p) => p.id === 'superbits')!;
    expect(sb).toMatchObject({
      name: 'SuperBits',
      infoUrl: '/torrent/{id}/',
      downloadUrl: '/download.php?id={id}&passkey={passkey}',
    });
    expect(sb.fields.map((f) => f.name)).toEqual(['passkey']);
    expect(core.sites.presets().length).toBeGreaterThan(100);
  });
});
