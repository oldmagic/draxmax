/** IPC channel names shared by main and preload. Only native-only features use IPC. */
export const IPC = {
  pickTorrentFiles: 'draxmax:pick-torrent-files',
  pickFolder: 'draxmax:pick-folder',
  openPath: 'draxmax:open-path',
} as const;
