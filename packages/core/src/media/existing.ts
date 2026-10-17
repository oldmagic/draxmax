import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { TorrentItem } from '@draxmax/shared';
import { episodeKeys, parseRelease } from './parse-title.ts';

const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|webm)$/i;
const SCAN_DEPTH = 2;

/** Video file names under a folder (a few levels deep); missing folders count as empty. */
export async function listVideos(root: string, depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > SCAN_DEPTH) return out;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) await listVideos(join(root, e.name), depth + 1, out);
    else if (VIDEO_EXT.test(e.name) && !/sample/i.test(e.name)) out.push(e.name);
  }
  return out;
}

/** What a release holds: its episodes ("show|s1e5", "show|s1" for a pack) or a movie ("title|2024"). */
export function contentKeys(name: string): string[] {
  const r = parseRelease(name);
  const keys = episodeKeys(r);
  if (keys.length > 0 || !r.key) return keys;
  return r.year !== undefined && r.episodes.length === 0 ? [`${r.key}|${r.year}`] : [];
}

/**
 * The torrent or video file that already holds every episode (or the movie) of `title`, looking
 * at the torrents in the client and the files in `folder`. Null when something is missing, or
 * when the name can't be parsed into a show/episode or movie/year.
 */
export async function findExisting(
  title: string,
  torrents: TorrentItem[],
  folder: string | null,
): Promise<string | null> {
  const wanted = contentKeys(title);
  if (wanted.length === 0) return null;
  const have = new Map<string, string>();
  const note = (name: string) => {
    for (const k of contentKeys(name)) if (!have.has(k)) have.set(k, name);
  };
  // An episode is also held by a whole-season pack ("show|s1e5" by "show|s1").
  const holder = (k: string) => have.get(k) ?? have.get(k.replace(/e\d+$/, ''));
  const covered = () => wanted.every((k) => holder(k) !== undefined);

  for (const t of torrents) {
    note(t.name);
    for (const f of t.files) if (VIDEO_EXT.test(f.name)) note(basename(f.path || f.name));
  }
  if (!covered() && folder) for (const name of await listVideos(folder)) note(name);
  return covered() ? holder(wanted[0]!)! : null;
}
