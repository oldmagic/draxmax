import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../core.ts';
import { FakeEngine } from '../testing/index.ts';

let dir: string;
let core: Core;
let engine: FakeEngine;

const boot = () => {
  engine = new FakeEngine();
  core = createCore({
    configPath: join(dir, 'c'),
    downloadPath: join(dir, 'd'),
    engine,
    env: {},
    noSchedulers: true,
  });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'draxmax-stats-'));
  boot();
});
afterEach(async () => {
  await core.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('StatsService', () => {
  it('summarises torrents, speeds, disk and top consumers', async () => {
    core.torrents.addMagnet(
      `magnet:?xt=urn:btih:${'1'.repeat(40)}&dn=A&tr=udp%3A%2F%2Ft.example%3A1`,
    );
    await new Promise((r) => setTimeout(r, 20));
    const t = engine.last;
    t.giveMetadata('A', [{ path: 'A/a', size: 100 }]);
    t.verify();
    t.state.downloadSpeed = 1000;
    t.state.uploadSpeed = 10;
    t.state.peers = 3;
    engine.totals = { downloaded: 500, uploaded: 50 };
    engine.nodes = 42;

    const s = await core.stats.tick();
    expect(s).toMatchObject({
      downloadSpeed: 1000,
      uploadSpeed: 10,
      peers: 3,
      dhtNodes: 42,
      torrents: { total: 1, downloading: 1 },
      trackers: { updating: 1 },
      session: { downloaded: 500, uploaded: 50, ratio: 0.1 },
    });
    expect(s.top).toEqual([
      { id: expect.any(String), name: 'A', downloadSpeed: 1000, uploadSpeed: 10 },
    ]);
    expect(s.disk?.total).toBeGreaterThan(0);
    expect(core.stats.history('live').samples).toHaveLength(1);
  });

  it('aggregates minutes into history and keeps all-time totals across restarts', async () => {
    const t0 = Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000;
    for (let i = 0; i < 3; i++) await core.stats.tick(t0 + i * 1000);
    await core.stats.tick(t0 + 60_000); // next minute flushes the first
    const day = core.stats.history('day');
    expect(day.step).toBe(60);
    expect(day.samples.map((s) => s.t)).toEqual([t0]);

    engine.totals = { downloaded: 1000, uploaded: 300 };
    await core.shutdown();
    boot();
    engine.totals = { downloaded: 10, uploaded: 0 };
    expect((await core.stats.snapshot()).allTime).toMatchObject({
      downloaded: 1010,
      uploaded: 300,
    });
  });
});
