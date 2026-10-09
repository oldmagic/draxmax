import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  shell,
  Tray,
} from 'electron';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { CoreError, createCore, type Core, type SecretCipher, type Settings } from '@draxmax/core';
import { buildServer } from '@draxmax/server';
import { APP_NAME, MAGNET_RE } from '@draxmax/shared';
import { IPC } from './ipc.ts';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = app.isPackaged ? join(process.resourcesPath, 'web') : join(here, '../../web/dist');
const resources = app.isPackaged
  ? join(process.resourcesPath, 'resources')
  : join(here, '../resources');
const startHidden = process.argv.includes('--hidden');

let core: Core | null = null;
let closeServer: (() => Promise<void>) | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let baseUrl = '';
let token = '';
let quitting = false;
let logError: (msg: string, err?: unknown) => void = (msg, err) => console.error(msg, err);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    void handleLaunchArgs(argv);
    showWindow();
  });
  app.setAsDefaultProtocolClient('magnet');
  void app
    .whenReady()
    .then(start)
    .catch((err: Error) => {
      dialog.showErrorBox(`${APP_NAME} could not start`, err.stack ?? err.message);
      app.exit(1);
    });
}

/** Secrets encrypted with the OS keychain when a real backend is available. */
function keychainCipher(): SecretCipher | undefined {
  if (!safeStorage.isEncryptionAvailable()) return undefined;
  // On Linux without a keyring Electron falls back to a hard-coded key; the key file is better.
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
    return undefined;
  return {
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (sealed) => safeStorage.decryptString(Buffer.from(sealed, 'base64')),
  };
}

async function start(): Promise<void> {
  const userData = app.getPath('userData');
  const logDir = join(userData, 'logs');
  mkdirSync(logDir, { recursive: true });

  core = createCore({
    configPath: join(userData, 'config'),
    downloadPath: join(app.getPath('downloads'), APP_NAME),
    cipher: keychainCipher(),
  });
  const failure = core.engineFailure();
  core.events.on('engine:fatal', showEngineFailure);
  if (failure) showEngineFailure(failure);

  // Per-launch secret: other local processes can't drive the API without it.
  token = randomBytes(24).toString('base64url');
  const server = await buildServer({
    core,
    webRoot,
    token,
    logger: {
      level: core.settings.get().logLevel,
      file: join(logDir, 'draxmax.log'),
    } as unknown as { level: string },
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  closeServer = () => server.close();
  baseUrl = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  logError = (msg, err) => server.log.error({ err }, msg);
  core.settings.onChange((s, changed) => {
    if (changed.includes('logLevel')) server.log.level = s.logLevel;
    if (changed.includes('startOnLogin') || changed.includes('startMinimized')) applyLoginItem(s);
  });

  registerIpc();
  wireNotifications(core);
  createTray(core);
  applyLoginItem(core.settings.get());
  if (!(startHidden || core.settings.get().startMinimized) || !tray) createWindow();
  await handleLaunchArgs(process.argv);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#17151f',
    title: APP_NAME,
    icon: join(resources, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  void mainWindow.loadURL(`${baseUrl}/downloads?token=${encodeURIComponent(token)}`);

  // Keep the window on our origin; anything else opens in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!isOwnOrigin(url)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logError(`Renderer gone: ${details.reason}`);
    if (details.reason !== 'clean-exit') mainWindow?.reload();
  });
  mainWindow.on('close', (e) => {
    // Close-to-tray keeps torrents running in the background.
    if (!quitting && tray && core?.settings.get().closeToTray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => (mainWindow = null));
}

function showWindow(): void {
  if (!baseUrl) return;
  if (!mainWindow) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function formatSpeed(b: number): string {
  if (b < 1024) return `${Math.round(b)} B/s`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB/s`;
  return `${(b / 1024 ** 2).toFixed(1)} MB/s`;
}

function createTray(c: Core): void {
  try {
    const image = nativeImage.createFromPath(join(resources, 'tray.png'));
    if (image.isEmpty()) return;
    tray = new Tray(image);
  } catch (err) {
    logError('Tray unavailable', err);
    return;
  }
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Show ${APP_NAME}`, click: showWindow },
      { type: 'separator' },
      { label: 'Pause all', click: () => void c.torrents.pauseAll() },
      { label: 'Resume all', click: () => c.torrents.resumeAll() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
  tray.on('click', showWindow);
  let last = 0;
  c.events.on('stats:tick', (s) => {
    if (Date.now() - last < 2000 || !tray) return;
    last = Date.now();
    const active = s.torrents.downloading;
    tray.setToolTip(
      `${APP_NAME} — ↓ ${formatSpeed(s.downloadSpeed)}  ↑ ${formatSpeed(s.uploadSpeed)}${active ? ` · ${active} downloading` : ''}`,
    );
  });
}

function wireNotifications(c: Core): void {
  const show = (title: string, body: string) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: join(resources, 'icon.png') });
    n.on('click', showWindow);
    n.show();
  };
  c.events.on(
    'torrent:done',
    (t) => c.settings.get().notifyOnComplete && show('Download complete', t.name),
  );
  c.events.on(
    'torrent:error',
    (t) => c.settings.get().notifyOnError && show(`Error: ${t.name}`, t.error ?? 'Unknown error'),
  );
  c.events.on(
    'rss:match',
    (m) =>
      m.status === 'added' &&
      c.settings.get().notifyOnRssMatch &&
      show(`RSS: ${m.ruleName}`, m.title),
  );
}

/** Start-on-login: native API on Windows/macOS, an XDG autostart entry on Linux. */
function applyLoginItem(s: Settings): void {
  if (!app.isPackaged) return; // dev builds would register the Electron binary itself
  const args = s.startMinimized ? ['--hidden'] : [];
  if (process.platform === 'linux') {
    const file = join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
      'autostart',
      'draxmax.desktop',
    );
    try {
      if (s.startOnLogin) {
        mkdirSync(dirname(file), { recursive: true });
        const exec = process.env.APPIMAGE ?? process.execPath;
        writeFileSync(
          file,
          `[Desktop Entry]\nType=Application\nName=${APP_NAME}\nExec="${exec}" ${args.join(' ')}\nX-GNOME-Autostart-enabled=true\n`,
        );
      } else {
        rmSync(file, { force: true });
      }
    } catch (err) {
      logError('Could not update autostart entry', err);
    }
    return;
  }
  app.setLoginItemSettings({ openAtLogin: s.startOnLogin, args });
}

/** Exact origin match: a prefix test would let http://127.0.0.1:12345 pass for port 1234. */
function isOwnOrigin(url: string | undefined): boolean {
  if (!url || !baseUrl) return false;
  try {
    return new URL(url).origin === baseUrl;
  } catch {
    return false;
  }
}

/** IPC is only for our own UI, never for a page that got loaded some other way. */
function fromOwnUi(e: Electron.IpcMainInvokeEvent): void {
  if (!isOwnOrigin(e.senderFrame?.url)) throw new Error('Not allowed');
}

function registerIpc(): void {
  ipcMain.handle(IPC.pickTorrentFiles, async (e) => {
    fromOwnUi(e);
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const opts = {
      title: 'Add torrent files',
      properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
      filters: [{ name: 'Torrent files', extensions: ['torrent'] }],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled) return [];
    return Promise.all(
      res.filePaths.map(async (p) => ({
        name: basename(p),
        data: (await readFile(p)).toString('base64'),
      })),
    );
  });
  ipcMain.handle(IPC.pickFolder, async (e, defaultPath: unknown) => {
    fromOwnUi(e);
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const opts = {
      title: 'Choose folder',
      defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined,
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC.openPath, async (e, path: unknown) => {
    fromOwnUi(e);
    if (typeof path !== 'string' || !path) return;
    // Only folders are opened. Opening a file would run it if it's a program (e.g. an
    // .exe that arrived in a torrent), so files are revealed in their folder instead.
    const info = await stat(path).catch(() => null);
    if (!info) throw new Error('Folder not found');
    if (!info.isDirectory()) return shell.showItemInFolder(path);
    const err = await shell.openPath(path);
    if (err) throw new Error(err);
  });
}

/** Adds magnet links and .torrent paths passed on the command line / by the OS. */
async function handleLaunchArgs(argv: string[]): Promise<void> {
  if (!core) return;
  for (const arg of argv.slice(1)) {
    try {
      if (MAGNET_RE.test(arg)) {
        core.torrents.addMagnet(arg);
      } else if (arg.toLowerCase().endsWith('.torrent') && (await stat(arg)).isFile()) {
        await core.torrents.addTorrentFile(await readFile(arg));
      }
    } catch (err) {
      // Opening a magnet that's already in the list is a no-op, not an error.
      if (err instanceof CoreError && err.code === 'conflict') continue;
      dialog.showErrorBox('Could not add torrent', (err as Error).message);
    }
  }
}

function showEngineFailure(err: Error): void {
  const hint = /EADDRINUSE/.test(err.message)
    ? '\n\nAnother program (or another DraxMax) is using the BitTorrent port. Close it or change the port in Settings → Connection, then restart.'
    : '';
  dialog.showErrorBox('BitTorrent engine stopped', err.message + hint);
}

// Crash safety: log unexpected errors instead of dying silently; torrents keep running.
process.on('uncaughtException', (err) => logError('Uncaught exception', err));
process.on('unhandledRejection', (err) => logError('Unhandled rejection', err));

app.on('activate', showWindow);

// macOS passes magnet links via open-url.
app.on('open-url', (e, url) => {
  e.preventDefault();
  void handleLaunchArgs(['', url]);
});

app.on('window-all-closed', () => {
  // With a tray and close-to-tray, keep seeding in the background.
  if (tray && core?.settings.get().closeToTray) return;
  app.quit();
});

app.on('before-quit', (e) => {
  quitting = true;
  if (!core) return;
  e.preventDefault();
  const c = core;
  core = null;
  const deadline = setTimeout(() => app.exit(0), 8000);
  void (async () => {
    try {
      await closeServer?.();
      await c.shutdown();
    } finally {
      clearTimeout(deadline);
      tray?.destroy();
      app.exit(0);
    }
  })();
});
