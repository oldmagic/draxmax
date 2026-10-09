import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from './ipc.ts';

// Everything else goes through the same HTTP/WS API as the Web UI.
contextBridge.exposeInMainWorld('draxmax', {
  platform: process.platform,
  pickTorrentFiles: (): Promise<{ name: string; data: string }[]> =>
    ipcRenderer.invoke(IPC.pickTorrentFiles),
  pickFolder: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.pickFolder, defaultPath),
  openPath: (path: string): Promise<void> => ipcRenderer.invoke(IPC.openPath, path),
});
