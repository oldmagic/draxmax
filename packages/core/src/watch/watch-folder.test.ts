import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../core.ts';
import { FakeEngine, makeTorrentFile } from '../testing/index.ts';

let dir: string;
let watch: string;
let core: Core;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'draxmax-watch-'));
  watch = join(dir, 'watch');
  mkdirSync(watch);
  core = createCore({
    configPath: join(dir, 'c'),
    downloadPath: join(dir, 'd'),
    engine: new FakeEngine(),
    env: { WATCH_PATH: watch },
    noSchedulers: true,
  });
});
afterEach(async () => {
  await core.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('WatchFolder', () => {
  it('adds .torrent and .magnet files once settled and moves them aside', async () => {
    writeFileSync(
      join(watch, 'a.torrent'),
      makeTorrentFile('FromWatch', [{ path: ['x.bin'], length: 3 }]),
    );
    writeFileSync(
      join(watch, 'links.magnet'),
      `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=M1\nnot a link\n`,
    );
    writeFileSync(join(watch, 'junk.torrent'), 'garbage');
    writeFileSync(join(watch, 'notes.txt'), 'ignored');

    // Too fresh: still being written.
    expect(await core.watch.poll(Date.now())).toEqual([]);
    const handled = await core.watch.poll(Date.now() + 5_000);
    expect(handled.sort()).toEqual(['a.torrent', 'junk.torrent', 'links.magnet']);
    expect(
      core.torrents
        .list()
        .map((t) => t.name)
        .sort(),
    ).toEqual(['FromWatch', 'M1']);
    expect(readdirSync(join(watch, '.added'))).toHaveLength(2);
    expect(readdirSync(join(watch, '.failed'))[0]).toMatch(/junk\.torrent$/);
    expect(existsSync(join(watch, 'notes.txt'))).toBe(true);
    expect(await core.watch.poll(Date.now() + 10_000)).toEqual([]);
  });
});
