import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsStore, envOverrides } from './settings.ts';

let dir: string;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe('settings', () => {
  it('parses typed env overrides and rejects garbage', () => {
    expect(
      envOverrides({ TORRENT_PORT: '51413', ENABLE_DHT: 'false', DOWNLOAD_PATH: '/d' }),
    ).toEqual({
      torrentPort: 51413,
      dht: false,
      downloadPath: '/d',
    });
    expect(() => envOverrides({ TORRENT_PORT: 'abc' })).toThrow(/integer/);
    expect(() => envOverrides({ ENABLE_DHT: 'maybe' })).toThrow(/boolean/);
  });

  it('layers defaults < file < env and persists only file values', () => {
    dir = mkdtempSync(join(tmpdir(), 'draxmax-settings-'));
    const file = join(dir, 'settings.json');
    const store = new SettingsStore(file, { downloadPath: '/default' }, { TORRENT_PORT: '7000' });
    expect(store.get()).toMatchObject({ downloadPath: '/default', torrentPort: 7000, dht: true });
    expect(store.lockedKeys()).toEqual(['torrentPort']);

    store.update({ downloadPath: '/mine', torrentPort: 9000 });
    expect(store.get()).toMatchObject({ downloadPath: '/mine', torrentPort: 7000 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      downloadPath: '/mine',
      torrentPort: 9000,
    });
    expect(() => store.update({ torrentPort: 99999 })).toThrow();
  });
});

describe('DHT port', () => {
  it('defaults to torrentPort + 1 and rejects a clash', async () => {
    const { effectiveDhtPort, settingsSchema } = await import('./settings.ts');
    const s = settingsSchema.parse({ downloadPath: '/d', torrentPort: 6881 });
    expect(effectiveDhtPort(s)).toBe(6882);
    expect(effectiveDhtPort(settingsSchema.parse({ downloadPath: '/d', torrentPort: 0 }))).toBe(0);
    expect(() =>
      settingsSchema.parse({ downloadPath: '/d', torrentPort: 7000, dhtPort: 7000 }),
    ).toThrow(/differ/);
  });
});
