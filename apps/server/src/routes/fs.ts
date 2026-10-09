import { constants } from 'node:fs';
import { access, mkdir, readdir, stat, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CoreError, type Core } from '@draxmax/core';
import { isAbsolutePath, mkdirSchema, type DirListing } from '@draxmax/shared';

const MAX_ENTRIES = 5000;
const listQuery = z.object({ path: z.string().max(4096).optional() });

function fsError(err: unknown, path: string): never {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR')
    throw new CoreError('not_found', `Folder not found: ${path}`);
  if (code === 'EACCES' || code === 'EPERM')
    throw new CoreError('invalid_input', `Permission denied: ${path}`);
  throw err;
}

async function listDir(path: string): Promise<DirListing> {
  const abs = resolve(path);
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch (err) {
    fsError(err, abs);
  }
  const dirs: string[] = [];
  for (const e of entries.slice(0, MAX_ENTRIES)) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) dirs.push(e.name);
    // Mount points are often symlinked in (e.g. /downloads/nas -> /mnt/nas).
    else if (e.isSymbolicLink())
      await stat(join(abs, e.name)).then(
        (s) => s.isDirectory() && dirs.push(e.name),
        () => {},
      );
  }
  dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  const freeBytes = await statfs(abs).then(
    (s) => s.bavail * s.bsize,
    () => null,
  );
  const writable = await access(abs, constants.W_OK).then(
    () => true,
    () => false,
  );
  const parent = dirname(abs);
  return { path: abs, parent: parent === abs ? null : parent, dirs, freeBytes, writable };
}

/**
 * Server-side folder browser for choosing save paths from the Web UI, where the browser
 * can't see the server's filesystem (Docker, NAS, remote machine).
 */
export async function fsRoutes(app: FastifyInstance, { core }: { core: Core }): Promise<void> {
  app.get('/api/fs/dirs', async (req) => {
    const { path } = listQuery.parse(req.query);
    const target = path?.trim() || core.settings.get().downloadPath;
    if (!isAbsolutePath(target)) throw new CoreError('invalid_input', 'Must be an absolute path');
    return listDir(target);
  });

  app.post('/api/fs/dirs', async (req, reply) => {
    const { path } = mkdirSchema.parse(req.body);
    try {
      await mkdir(resolve(path), { recursive: true });
    } catch (err) {
      fsError(err, path);
    }
    return reply.status(201).send(await listDir(path));
  });
}
