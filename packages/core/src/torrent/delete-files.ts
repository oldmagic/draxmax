import { readdir, rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Deletes a torrent's files from `savePath` and prunes directories left empty.
 * Paths that would escape `savePath` are ignored.
 */
export async function deleteTorrentFiles(savePath: string, relativePaths: string[]): Promise<void> {
  const root = resolve(savePath);
  const dirs = new Set<string>();
  for (const p of relativePaths) {
    const target = resolve(root, p);
    if (!isInside(root, target)) continue;
    await rm(target, { force: true });
    for (let d = dirname(target); isInside(root, d); d = dirname(d)) dirs.add(d);
  }
  // Deepest first so parents become empty before we reach them.
  const ordered = [...dirs].sort((a, b) => b.length - a.length);
  for (const d of ordered) {
    try {
      if ((await readdir(d)).length === 0) await rmdir(d);
    } catch {
      // Already gone or not empty: leave it.
    }
  }
}
