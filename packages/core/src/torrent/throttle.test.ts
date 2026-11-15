import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebTorrent from 'webtorrent';

/**
 * Real transfers between two WebTorrent clients on localhost, to check the per-torrent
 * throttle added by patches/webtorrent@3.0.21.patch in both directions. The leecher dials the
 * seeder, so the download limit runs on an outgoing peer and the upload limit on an incoming
 * one (which only learns its torrent at handshake).
 */

// Only what these tests use; the shared vendor types don't cover seeding.
interface TestTorrent {
  torrentFile: Uint8Array;
  done: boolean;
  throttleDownload(rate: number): void;
  throttleUpload(rate: number): void;
  addPeer(addr: string): boolean;
  once(event: 'done' | 'ready', cb: () => void): void;
}
interface TestClient {
  torrentPort: number;
  seed(input: Buffer, opts: object, cb: (t: TestTorrent) => void): void;
  add(id: Uint8Array, opts: object, cb?: (t: TestTorrent) => void): TestTorrent;
  once(event: 'listening', cb: () => void): void;
  destroy(cb?: () => void): void;
}

const SIZE = 512 * 1024;
const LIMIT = 256 * 1024;
const OPTS = {
  dht: false,
  tracker: false,
  lsd: false,
  utPex: false,
  natUpnp: false,
  natPmp: false,
};

let dir: string;
let clients: TestClient[] = [];

function client(): TestClient {
  const c = new WebTorrent({ ...OPTS, utp: false, torrentPort: 0 }) as unknown as TestClient;
  clients.push(c);
  return c;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'draxmax-throttle-'));
});

afterEach(async () => {
  await Promise.all(clients.map((c) => new Promise<void>((r) => c.destroy(() => r()))));
  clients = [];
  rmSync(dir, { recursive: true, force: true });
});

/** Seeds SIZE random bytes, downloads them with a second client and returns the seconds taken. */
async function transfer(limit: (seed: TestTorrent, leech: TestTorrent) => void): Promise<number> {
  const seeder = client();
  const leecher = client();
  const data = randomBytes(SIZE);
  const seed = await new Promise<TestTorrent>((resolve) =>
    seeder.seed(data, { name: 'data.bin', announce: [], path: join(dir, 'seed') }, resolve),
  );
  if (!seeder.torrentPort) await new Promise<void>((r) => seeder.once('listening', r));
  const leech = leecher.add(seed.torrentFile, { path: join(dir, 'leech'), announce: [] });
  limit(seed, leech);
  await new Promise<void>((r) => leech.once('ready', r));
  const started = performance.now();
  const done = new Promise<void>((r) => (leech.done ? r() : leech.once('done', r)));
  leech.addPeer(`127.0.0.1:${seeder.torrentPort}`);
  await done;
  return (performance.now() - started) / 1000;
}

describe('per-torrent rate limits (webtorrent patch)', () => {
  it('transfers at full speed without a limit', async () => {
    expect(await transfer(() => {})).toBeLessThan(1);
  });

  it('limits a torrent download', async () => {
    const seconds = await transfer((_seed, leech) => leech.throttleDownload(LIMIT));
    // 512 KiB at 256 KiB/s from an empty bucket: about 2 s.
    expect(seconds).toBeGreaterThan(1.5);
    expect(seconds).toBeLessThan(6);
  });

  it('limits a torrent upload, also to peers that connected to us', async () => {
    const seconds = await transfer((seed) => seed.throttleUpload(LIMIT));
    expect(seconds).toBeGreaterThan(1.5);
    expect(seconds).toBeLessThan(6);
  });

  it('lifts a limit with -1', async () => {
    const seconds = await transfer((_seed, leech) => {
      leech.throttleDownload(LIMIT);
      leech.throttleDownload(-1);
    });
    expect(seconds).toBeLessThan(1);
  });
});
