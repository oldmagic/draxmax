import { copyFile, mkdir, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Moves a torrent's files from one save folder to another, keeping their relative paths,
 * and prunes directories left empty. Files that don't exist (never downloaded) are skipped;
 * paths that would escape either folder are ignored. A move to another drive is a copy
 * followed by removing the original.
 */
export async function moveTorrentFiles(
  from: string,
  to: string,
  relativePaths: string[],
): Promise<void> {
  const src = resolve(from);
  const dst = resolve(to);
  if (src === dst) return;
  await mkdir(dst, { recursive: true });
  const dirs = new Set<string>();
  for (const p of relativePaths) {
    const a = resolve(src, p);
    const b = resolve(dst, p);
    if (!isInside(src, a) || !isInside(dst, b)) continue;
    try {
      await stat(a);
    } catch {
      continue;
    }
    await mkdir(dirname(b), { recursive: true });
    try {
      await rename(a, b);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await copyFile(a, b);
      await unlink(a);
    }
    for (let d = dirname(a); isInside(src, d); d = dirname(d)) dirs.add(d);
  }
  // Deepest first so parents become empty before we reach them.
  for (const d of [...dirs].sort((x, y) => y.length - x.length)) {
    try {
      if ((await readdir(d)).length === 0) await rmdir(d);
    } catch {
      // Already gone or not empty: leave it.
    }
  }
}
