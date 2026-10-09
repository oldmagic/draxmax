/** Bridge exposed by the Electron preload script. Absent in the browser Web UI. */
export interface DesktopBridge {
  platform: string;
  /** Native file picker; returns selected .torrent files as base64. */
  pickTorrentFiles(): Promise<{ name: string; data: string }[]>;
  openPath(path: string): Promise<void>;
  /** Native folder picker; resolves to the chosen path or null. */
  pickFolder?(defaultPath?: string): Promise<string | null>;
}

declare global {
  interface Window {
    draxmax?: DesktopBridge;
  }
}

export const desktop: DesktopBridge | undefined = window.draxmax;
