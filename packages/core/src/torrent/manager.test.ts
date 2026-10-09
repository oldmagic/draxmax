import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCore, type Core } from '../core.ts';
import { FakeEngine, makeTorrentFile } from '../testing/index.ts';

const HASH = 'c9e15763f722f23e98a29decdfae341b98d53056';
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Cosmos+Laundromat&tr=udp%3A%2F%2Ftracker.one%3A1337`;
const magnetN = (n: number) => `magnet:?xt=urn:btih:${n.toString(16).padStart(40, '0')}&dn=T${n}`;

let dir: string;
let engine: FakeEngine;
let core: Core;

function boot(env: NodeJS.ProcessEnv = {}): Core {
  engine = new FakeEngine();
  core = createCore({
    configPath: join(dir, 'config'),
    downloadPath: join(dir, 'downloads'),
    engine,
    env,
  });
  return core;
}

/** Lets async starts (torrent parsing) finish. */
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'draxmax-test-'));
  boot();
});

afterEach(async () => {
  vi.useRealTimers();
  await core.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('TorrentManager: adding', () => {
  it('adds a magnet, keeps its trackers but starts the engine without tr= params', async () => {
    const item = core.torrents.addMagnet(MAGNET);
    await settle();
    expect(item.infoHash).toBe(HASH);
    expect(item.name).toBe('Cosmos Laundromat');
    expect(item.trackers.map((t) => t.url)).toEqual(['udp://tracker.one:1337']);
    expect(core.torrents.get(item.id).status).toBe('metadata');
    expect(engine.last.source).toBe(`magnet:?xt=urn:btih:${HASH}&dn=Cosmos+Laundromat`);
    expect(engine.last.opts.announce).toEqual(['udp://tracker.one:1337']);
  });

  it('rejects malformed magnets and duplicates', () => {
    expect(() => core.torrents.addMagnet('magnet:?dn=nothing')).toThrow(/info-hash/);
    core.torrents.addMagnet(MAGNET);
    expect(() => core.torrents.addMagnet(MAGNET)).toThrow(/already/);
  });

  it('adds a .torrent file with its file list known up front', async () => {
    const data = makeTorrentFile('Show', [
      { path: ['a.mkv'], length: 1000 },
      { path: ['b.nfo'], length: 10 },
    ]);
    const item = await core.torrents.addTorrentFile(data);
    expect(item.name).toBe('Show');
    expect(item.totalSize).toBe(1010);
    expect(item.files.map((f) => f.path)).toEqual([join('Show', 'a.mkv'), join('Show', 'b.nfo')]);
    await settle();
    // Started from a parsed torrent with the managed tracker list.
    expect(typeof engine.last.source).toBe('object');
    expect(engine.last.opts.announce).toEqual(['udp://tracker.example:1337']);
    await expect(core.torrents.addTorrentFile(new Uint8Array([1, 2]))).rejects.toThrow(/valid/);
  });

  it('appends default trackers when enabled and applies category save paths', async () => {
    core.settings.update({
      addDefaultTrackers: true,
      defaultTrackers: ['udp://extra.example:80/announce'],
    });
    core.categories.save({ name: 'Movies', savePath: join(dir, 'movies') });
    const item = core.torrents.addMagnet(MAGNET, { category: 'Movies', tags: ['hd', 'hd', ' '] });
    expect(item.trackers.map((t) => t.url)).toEqual([
      'udp://tracker.one:1337',
      'udp://extra.example:80/announce',
    ]);
    expect(item.savePath).toBe(join(dir, 'movies'));
    expect(item.category).toBe('Movies');
    expect(item.tags).toEqual(['hd']);
    // Unknown categories are created on the fly.
    core.torrents.addMagnet(magnetN(1), { category: 'TV' });
    expect(core.categories.list().map((c) => c.name)).toEqual(['Movies', 'TV']);
  });
});

describe('TorrentManager: transfer state', () => {
  it('applies file priorities when metadata arrives and tracks wanted progress', async () => {
    const { id } = core.torrents.addMagnet(MAGNET);
    await settle();
    const t = engine.last;
    t.giveMetadata('Movie', [
      { path: 'Movie/movie.mkv', size: 1000 },
      { path: 'Movie/sample.mkv', size: 100 },
    ]);
    expect(t.priorities).toEqual([1, 1]);

    core.torrents.setFilePriorities(id, [{ index: 1, priority: 0 }]);
    expect(t.priorities).toEqual([1, 0]);

    t.verify();
    t.progress(0, 500);
    const item = core.torrents.get(id);
    expect(item.status).toBe('downloading');
    expect(item.progress).toBeCloseTo(0.5);
    expect(item.files[1]!.selected).toBe(false);
  });

  it('marks completion once all wanted files are verified and emits done', async () => {
    await core.shutdown();
    vi.useFakeTimers();
    boot();
    const done = vi.fn();
    core.events.on('torrent:done', done);
    const { id } = core.torrents.addMagnet(MAGNET);
    await vi.advanceTimersByTimeAsync(10);
    const t = engine.last;
    t.giveMetadata('Movie', [
      { path: 'Movie/movie.mkv', size: 1000 },
      { path: 'Movie/extra.mkv', size: 100 },
    ]);
    core.torrents.setFilePriorities(id, [{ index: 1, priority: 0 }]);
    t.verify();
    t.progress(0, 1000);
    await vi.advanceTimersByTimeAsync(1500);
    expect(done).toHaveBeenCalledOnce();
    const item = core.torrents.get(id);
    expect(item.status).toBe('seeding');
    expect(item.completedAt).toBeInstanceOf(Date);
  });

  it('pause stops the engine torrent; resume restarts with the resume bitfield', async () => {
    const { id } = core.torrents.addMagnet(MAGNET);
    await settle();
    const first = engine.last;
    first.giveMetadata('Movie', [{ path: 'Movie/movie.mkv', size: 1000 }]);
    first.verify();
    first.progress(0, 400);
    first.state.uploaded = 50;

    const paused = await core.torrents.pause(id);
    expect(first.destroyed).toBe(true);
    expect(paused.status).toBe('paused');
    expect(paused.progress).toBeCloseTo(0.4);
    expect(paused.uploaded).toBe(50);

    core.torrents.resume(id);
    await settle();
    expect(engine.added).toHaveLength(2);
    expect(engine.last.opts.bitfield).toEqual(new Uint8Array([0xff]));
    // Restarted from the stored metadata, not the magnet.
    expect(typeof engine.last.source).toBe('object');
  });

  it('survives a restart: records, pause state and counters are restored', async () => {
    const a = core.torrents.addMagnet(MAGNET);
    await settle();
    engine.last.giveMetadata('Movie', [{ path: 'Movie/movie.mkv', size: 1000 }]);
    engine.last.verify();
    engine.last.state.uploaded = 77;
    const b = await core.torrents.addTorrentFile(
      makeTorrentFile('Paused', [{ path: ['x.bin'], length: 5 }]),
      { paused: true },
    );
    await core.shutdown();

    boot();
    await settle();
    const items = core.torrents.list();
    expect(items.map((i) => i.id)).toEqual([a.id, b.id]);
    expect(items[0]!.uploaded).toBe(77);
    expect(items[0]!.name).toBe('Movie');
    expect(items[1]!.status).toBe('paused');
    // Only the running torrent was restarted.
    expect(engine.added).toHaveLength(1);
    expect(engine.last.opts.bitfield).toEqual(new Uint8Array([0xff]));
  });

  it('moves a torrent into error state on engine failure and clears it on resume', async () => {
    const { id } = core.torrents.addMagnet(MAGNET);
    await settle();
    const onError = vi.fn();
    core.events.on('torrent:error', onError);
    engine.last.fail('disk full');
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(core.torrents.get(id).status).toBe('error');
    expect(core.torrents.get(id).error).toBe('disk full');
    expect(core.torrents.resume(id).error).toBeUndefined();
  });

  it('toggles sequential mode live and updates tags/category', async () => {
    const { id } = core.torrents.addMagnet(MAGNET);
    await settle();
    expect(engine.last.sequential).toBe(false);
    const item = core.torrents.update(id, {
      sequential: true,
      tags: ['a', 'b'],
      category: 'Linux',
    });
    expect(engine.last.sequential).toBe(true);
    expect(item).toMatchObject({ sequentialDownload: true, tags: ['a', 'b'], category: 'Linux' });
    expect(core.torrents.tags()).toEqual(['a', 'b']);
    core.categories.delete('Linux');
    expect(core.torrents.get(id).category).toBeUndefined();
  });
});

describe('TorrentManager: queue', () => {
  it('runs at most maxActiveDownloads incomplete torrents, in queue order', async () => {
    core.settings.update({ maxActiveDownloads: 2 });
    const ids = [1, 2, 3].map((n) => core.torrents.addMagnet(magnetN(n)).id);
    await settle();
    expect(engine.running).toHaveLength(2);
    expect(core.torrents.get(ids[2]!).status).toBe('queued');

    // Moving the third to the top swaps which ones run.
    core.torrents.moveInQueue(ids[2]!, 'top');
    await settle();
    expect(core.torrents.list().map((t) => t.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(core.torrents.get(ids[1]!).status).toBe('queued');
    expect(core.torrents.get(ids[2]!).status).toBe('metadata');

    // Raising the limit starts everything.
    core.settings.update({ maxActiveDownloads: 0 });
    await settle();
    expect(core.torrents.list().every((t) => t.status === 'metadata')).toBe(true);
  });

  it('a finished download frees its slot', async () => {
    core.settings.update({ maxActiveDownloads: 1 });
    await core.shutdown();
    vi.useFakeTimers();
    boot();
    const a = core.torrents.addMagnet(magnetN(1));
    const b = core.torrents.addMagnet(magnetN(2));
    await vi.advanceTimersByTimeAsync(10);
    expect(core.torrents.get(b.id).status).toBe('queued');
    const ta = engine.running[0]!;
    ta.giveMetadata('A', [{ path: 'A/a', size: 10 }]);
    ta.complete();
    await vi.advanceTimersByTimeAsync(1100);
    expect(core.torrents.get(a.id).status).toBe('seeding');
    expect(core.torrents.get(b.id).status).toBe('metadata');
  });

  it('counts seeding time across restarts and removes the torrent (keeping files) at the limit', async () => {
    await core.shutdown();
    vi.useFakeTimers();
    boot();
    const a = core.torrents.addMagnet(magnetN(1));
    await vi.advanceTimersByTimeAsync(10);
    const ta = engine.running[0]!;
    ta.giveMetadata('A', [{ path: 'A/a', size: 10 }]);
    ta.complete();
    await vi.advanceTimersByTimeAsync(30_000);
    const seeded = core.torrents.get(a.id).seedingTime;
    expect(seeded).toBeGreaterThanOrEqual(28);
    expect(seeded).toBeLessThanOrEqual(30);

    // Paused time doesn't count.
    await core.torrents.pause(a.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(core.torrents.get(a.id).seedingTime).toBe(seeded);

    // Survives a restart.
    await core.shutdown();
    boot();
    expect(core.torrents.get(a.id).seedingTime).toBe(seeded);

    const file = join(dir, 'downloads', 'A', 'a');
    mkdirSync(join(dir, 'downloads', 'A'), { recursive: true });
    writeFileSync(file, 'data');
    const onSeeded = vi.fn();
    core.events.on('torrent:seeded', onSeeded);
    core.settings.update({ seedTimeLimitMinutes: 1 });
    core.torrents.resume(a.id);
    await vi.advanceTimersByTimeAsync(10);
    const tb = engine.running[0]!;
    tb.giveMetadata('A', [{ path: 'A/a', size: 10 }]);
    tb.complete();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(core.torrents.list()).toEqual([]);
    expect(onSeeded).toHaveBeenCalledOnce();
    expect(onSeeded.mock.calls[0]![0]).toMatchObject({ id: a.id, name: 'A' });
    expect(existsSync(file)).toBe(true);
  });
});

describe('TorrentManager: trackers', () => {
  it('adds, disables and removes trackers, restarting the engine torrent with the new list', async () => {
    const { id } = core.torrents.addMagnet(MAGNET);
    await settle();
    await expect(core.torrents.addTrackers(id, ['ftp://nope'])).rejects.toThrow(/Invalid tracker/);

    let item = await core.torrents.addTrackers(id, [
      'https://t2.example/announce',
      'udp://tracker.one:1337/',
    ]);
    expect(item.trackers.map((t) => t.url)).toEqual([
      'udp://tracker.one:1337',
      'https://t2.example/announce',
    ]);
    expect(engine.last.opts.announce).toEqual([
      'udp://tracker.one:1337',
      'https://t2.example/announce',
    ]);

    item = await core.torrents.setTrackerEnabled(id, 'udp://tracker.one:1337', false);
    expect(item.trackers[0]!.status).toBe('disabled');
    expect(engine.last.opts.announce).toEqual(['https://t2.example/announce']);

    item = await core.torrents.removeTrackers(id, ['udp://tracker.one:1337']);
    expect(item.trackers.map((t) => t.url)).toEqual(['https://t2.example/announce']);
    expect(engine.running).toHaveLength(1);
  });

  it('reports live tracker status and reannounces', async () => {
    const { id } = core.torrents.addMagnet(MAGNET);
    await settle();
    engine.last.trackerStats = [
      {
        url: 'udp://tracker.one:1337',
        status: 'working',
        seeders: 5,
        leechers: 2,
        lastAnnounce: new Date(0),
      },
    ];
    const [t] = core.torrents.get(id).trackers;
    expect(t).toMatchObject({ status: 'working', seeders: 5, leechers: 2, peers: 7 });
    core.torrents.reannounce(id);
    expect(engine.last.reannounced).toBe(1);
  });

  it('recheck restarts without resume data', async () => {
    const { id } = core.torrents.addMagnet(MAGNET);
    await settle();
    engine.last.giveMetadata('Movie', [{ path: 'Movie/m', size: 10 }]);
    engine.last.verify();
    await core.torrents.pause(id);
    core.torrents.resume(id);
    await settle();
    expect(engine.last.opts.bitfield).toBeDefined();
    await core.torrents.recheck(id);
    expect(engine.last.opts.bitfield).toBeUndefined();
  });
});

describe('TorrentManager: removal', () => {
  it('removes with and without data, never escaping the save path', async () => {
    const downloads = join(dir, 'downloads');
    const keep = core.torrents.addMagnet(MAGNET);
    await settle();
    engine.last.giveMetadata('Keep', [{ path: 'Keep/a.bin', size: 1 }]);
    mkdirSync(join(downloads, 'Keep'), { recursive: true });
    writeFileSync(join(downloads, 'Keep/a.bin'), 'x');
    await core.torrents.remove(keep.id, false);
    expect(existsSync(join(downloads, 'Keep/a.bin'))).toBe(true);

    writeFileSync(join(dir, 'outside.txt'), 'x');
    const del = await core.torrents.addTorrentFile(
      makeTorrentFile('Gone', [{ path: ['sub', 'b.bin'], length: 1 }]),
    );
    await settle();
    engine.last.giveMetadata('Gone', [
      { path: 'Gone/sub/b.bin', size: 1 },
      { path: '../outside.txt', size: 1 },
    ]);
    mkdirSync(join(downloads, 'Gone/sub'), { recursive: true });
    writeFileSync(join(downloads, 'Gone/sub/b.bin'), 'x');
    await core.torrents.remove(del.id, true);
    expect(existsSync(join(downloads, 'Gone'))).toBe(false);
    expect(existsSync(join(dir, 'outside.txt'))).toBe(true);
    expect(core.torrents.list()).toHaveLength(0);
  });

  it('throws not_found for unknown ids', () => {
    expect(() => core.torrents.get('nope')).toThrow(/not found/);
  });
});
