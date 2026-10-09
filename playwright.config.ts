import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'draxmax-e2e-'));
const PORT = 8787;

/** Smoke tests against the production server bundle (`pnpm build` first). */
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node apps/server/dist/server.js',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      CONFIG_PATH: join(dataDir, 'config'),
      DOWNLOAD_PATH: join(dataDir, 'downloads'),
      // Keep the test hermetic: random ports, no DHT/UPnP traffic.
      TORRENT_PORT: '0',
      ENABLE_DHT: 'false',
      ENABLE_UPNP: 'false',
      ENABLE_NATPMP: 'false',
      ENABLE_LSD: 'false',
      ANILIST_ENABLED: 'false',
      RSS_ENABLED: 'false',
      LOG_LEVEL: 'silent',
    },
  },
});
