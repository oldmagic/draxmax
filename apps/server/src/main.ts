import { chownSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCore } from '@draxmax/core';
import { buildServer } from './app.ts';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;

const port = Number(env.PORT ?? 8895);
const host = env.HOST ?? '0.0.0.0';
const configPath = resolve(env.CONFIG_PATH ?? './data/config');
const downloadPath = resolve(env.DOWNLOAD_PATH ?? './data/downloads');
// dist/server.js → ../../web/dist ; src/main.ts (dev) → same relative location.
const webRoot = resolve(env.WEB_ROOT ?? resolve(here, '../../web/dist'));

/**
 * Started as root outside Docker (e.g. a systemd unit without User=): switch to the
 * configured "run as" account before touching any files. Docker does this in its entrypoint.
 */
function dropPrivileges(): boolean {
  if (process.getuid?.() !== 0 || env.DRAXMAX_DOCKER === '1') return false;
  let s: { runAsUid?: number; runAsGid?: number } = {};
  try {
    s = JSON.parse(readFileSync(join(configPath, 'settings.json'), 'utf8')) as typeof s;
  } catch {
    // No settings yet: keep running as root until a user is chosen.
  }
  if (s.runAsUid === undefined) return true;
  const uid = s.runAsUid;
  const gid = s.runAsGid ?? uid;
  const chownTree = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) chownTree(join(dir, e.name));
      chownSync(join(dir, e.name), uid, gid);
    }
    chownSync(dir, uid, gid);
  };
  chownTree(configPath);
  process.setgroups?.([gid]);
  process.setgid?.(gid);
  process.setuid?.(uid);
  return true;
}
const startedAsRoot = dropPrivileges();

const core = createCore({ configPath, downloadPath });
const app = await buildServer({
  core,
  webRoot,
  token: env.API_TOKEN || undefined,
  auth: {
    envPassword: env.WEBUI_PASSWORD || undefined,
    disabled: ['1', 'true', 'yes'].includes((env.AUTH_DISABLED ?? '').toLowerCase()),
  },
  logger: { level: core.settings.get().logLevel },
  identity: {
    canApply: startedAsRoot || env.DRAXMAX_IDENTITY_MANAGED === '1',
    // In Docker the restart policy starts us again (and the entrypoint applies the ids).
    ...(env.DRAXMAX_DOCKER === '1' ? { restart: () => void shutdown('restart requested') } : {}),
  },
});
core.settings.onChange((s, changed) => {
  if (changed.includes('logLevel')) app.log.level = s.logLevel;
});

let shuttingDown = false;
async function shutdown(signal: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${signal}: shutting down`);
  // Hard deadline so a stuck peer socket can never block container stop.
  setTimeout(() => process.exit(1), 10_000).unref();
  try {
    await app.close();
    await core.shutdown();
    process.exit(code);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// A dead engine can't recover in-process; exit non-zero so the supervisor restarts us.
function onEngineFatal(err: Error): void {
  app.log.fatal(`BitTorrent engine failed: ${err.message}`);
  if (/EADDRINUSE/.test(err.message)) {
    app.log.fatal('A listen port is already in use. Set TORRENT_PORT / DHT_PORT to free ports.');
  }
  void shutdown('engine failure', 1);
}
core.events.on('engine:fatal', onEngineFatal);
const earlyFailure = core.engineFailure();
if (earlyFailure) onEngineFatal(earlyFailure);
core.events.on('engine:warning', (err) => app.log.warn(`BitTorrent engine: ${err.message}`));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port, host });
app.log.info(
  `DraxMax listening on http://${host}:${port} (config: ${configPath}, downloads: ${downloadPath})`,
);
if (!app.auth.configured())
  app.log.warn(
    `No Web UI login yet. To create one from another device, open the Web UI and enter setup code ${app.auth.setupCode} (from this machine no code is needed).`,
  );
