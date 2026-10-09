import { toast } from 'sonner';
import type { AddMagnetRequest, TorrentDTO, UpdateTorrentRequest } from '@draxmax/shared';
import { api, fileToBase64 } from '@/lib/api';
import { queryClient } from '@/lib/query';
import { useTorrents } from '@/stores/torrents';

/** Runs a mutation, toasting failures. */
async function run<T>(fn: () => Promise<T>, onOk?: (v: T) => void): Promise<T | undefined> {
  try {
    const v = await fn();
    onOk?.(v);
    return v;
  } catch (err) {
    toast.error((err as Error).message);
    return undefined;
  }
}

const upsert = (t: TorrentDTO) => useTorrents.getState().upsert(t);

/** Applies `fn` to every id, merging results; reports failures once. */
async function bulk(
  ids: string[],
  fn: (id: string) => Promise<TorrentDTO | undefined>,
  label: string,
): Promise<void> {
  const results = await Promise.allSettled(ids.map(fn));
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) upsert(r.value);
    if (r.status === 'rejected') failed++;
  }
  if (failed) toast.error(`${label} failed for ${failed} torrent${failed === 1 ? '' : 's'}`);
}

type AddExtras = Omit<AddMagnetRequest, 'magnetURI'>;

export const actions = {
  addMagnet: (magnetURI: string, extra: AddExtras = {}) =>
    run(
      () => api.addMagnet({ magnetURI, ...extra }),
      (t) => {
        upsert(t);
        toast.success('Torrent added', { description: t.name });
      },
    ),

  /** Adds each dropped/picked `.torrent`; non-torrent files are skipped with a warning. */
  async addFiles(files: File[], extra: AddExtras = {}): Promise<number> {
    let added = 0;
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith('.torrent')) {
        toast.warning(`Skipped ${file.name}`, { description: 'Only .torrent files can be added.' });
        continue;
      }
      const data = await fileToBase64(file);
      const t = await run(() => api.addTorrentFile({ fileName: file.name, data, ...extra }));
      if (t) {
        upsert(t);
        added++;
        toast.success('Torrent added', { description: t.name });
      }
    }
    return added;
  },

  async addBase64(files: { name: string; data: string }[], extra: AddExtras = {}): Promise<void> {
    for (const f of files) {
      await run(
        () => api.addTorrentFile({ fileName: f.name, data: f.data, ...extra }),
        (t) => {
          upsert(t);
          toast.success('Torrent added', { description: t.name });
        },
      );
    }
  },

  pause: (ids: string[]) => bulk(ids, (id) => api.pause(id), 'Pause'),
  resume: (ids: string[]) => bulk(ids, (id) => api.resume(id), 'Resume'),
  recheck: (ids: string[]) =>
    bulk(ids, (id) => api.recheck(id), 'Recheck').then(() =>
      toast.info('Rechecking data on disk…'),
    ),
  reannounce: (ids: string[]) =>
    bulk(ids, (id) => api.reannounce(id), 'Reannounce').then(() =>
      toast.info('Announcing to trackers…'),
    ),
  queue: (ids: string[], move: 'top' | 'up' | 'down' | 'bottom') =>
    // Apply in an order that keeps the selection's relative order.
    (async () => {
      const list = move === 'top' || move === 'down' ? [...ids].reverse() : ids;
      for (const id of list) await run(() => api.queue(id, move), upsert);
    })(),
  update: (ids: string[], patch: UpdateTorrentRequest) =>
    bulk(ids, (id) => api.update(id, patch), 'Update').then(() => {
      void queryClient.invalidateQueries({ queryKey: ['categories'] });
      void queryClient.invalidateQueries({ queryKey: ['tags'] });
    }),
  async remove(ids: string[], deleteFiles: boolean): Promise<void> {
    const results = await Promise.allSettled(ids.map((id) => api.remove(id, deleteFiles)));
    results.forEach((r, i) => r.status === 'fulfilled' && useTorrents.getState().drop(ids[i]!));
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) toast.error(`Remove failed for ${failed} torrent${failed === 1 ? '' : 's'}`);
  },
  setFilePriorities: (id: string, files: { index: number; priority: number }[]) =>
    run(() => api.setFilePriorities(id, files), upsert),
  addTrackers: (id: string, urls: string[]) => run(() => api.addTrackers(id, urls), upsert),
  removeTracker: (id: string, url: string) => run(() => api.removeTrackers(id, [url]), upsert),
  setTrackerEnabled: (id: string, url: string, enabled: boolean) =>
    run(() => api.setTrackerEnabled(id, url, enabled), upsert),
};
