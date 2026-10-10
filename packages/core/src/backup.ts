import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_VERSION } from '@draxmax/shared';
import type { Database } from './db/database.ts';
import { CoreError } from './errors.ts';

const FILES = ['settings.json', 'secret.key', 'draxmax.db'] as const;
const STAGE_DIR = 'restore';
const READY = 'READY';

/** Everything DraxMax knows, as one JSON document (file contents are base64). */
export interface BackupBundle {
  app: 'draxmax';
  version: string;
  createdAt: string;
  files: Partial<Record<(typeof FILES)[number], string>>;
}

/**
 * Snapshot of the config folder: settings, the key that decrypts stored secrets, and a
 * consistent copy of the database (torrents, rules, feeds, sites, history).
 */
export function createBackup(db: Database, configPath: string): BackupBundle {
  const tmp = join(configPath, `backup-${process.pid}-${Date.now()}.db`);
  const files: BackupBundle['files'] = {};
  try {
    // VACUUM INTO writes a compact, transactionally consistent copy while we keep running.
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    files['draxmax.db'] = readFileSync(tmp).toString('base64');
  } finally {
    rmSync(tmp, { force: true });
  }
  for (const name of ['settings.json', 'secret.key'] as const) {
    const path = join(configPath, name);
    if (existsSync(path)) files[name] = readFileSync(path).toString('base64');
  }
  return { app: 'draxmax', version: APP_VERSION, createdAt: new Date().toISOString(), files };
}

/**
 * Checks a backup and puts it aside; it replaces the live files on the next start (the
 * database can't be swapped while it is open). Throws `invalid_input` for anything that
 * isn't a DraxMax backup.
 */
export function stageRestore(configPath: string, input: unknown): void {
  const bundle = input as Partial<BackupBundle> | null;
  if (!bundle || bundle.app !== 'draxmax' || typeof bundle.files !== 'object' || !bundle.files)
    throw new CoreError('invalid_input', 'This is not a DraxMax backup file');
  const decoded = new Map<string, Buffer>();
  for (const name of FILES) {
    const b64 = bundle.files[name];
    if (b64 === undefined) continue;
    if (typeof b64 !== 'string') throw new CoreError('invalid_input', `Backup is damaged: ${name}`);
    decoded.set(name, Buffer.from(b64, 'base64'));
  }
  const db = decoded.get('draxmax.db');
  if (!db || db.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0')
    throw new CoreError('invalid_input', 'Backup is damaged: the database is missing or invalid');
  const settings = decoded.get('settings.json');
  if (settings) {
    try {
      JSON.parse(settings.toString('utf8'));
    } catch {
      throw new CoreError('invalid_input', 'Backup is damaged: settings are not valid JSON');
    }
  }
  const key = decoded.get('secret.key');
  if (key && Buffer.from(key.toString('utf8').trim(), 'base64').length !== 32)
    throw new CoreError('invalid_input', 'Backup is damaged: the secret key is invalid');

  const stage = join(configPath, STAGE_DIR);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  for (const [name, data] of decoded) writeFileSync(join(stage, name), data, { mode: 0o600 });
  // Written last: a half-written stage (crash, full disk) is never applied.
  writeFileSync(join(stage, READY), new Date().toISOString(), { mode: 0o600 });
}

/**
 * Applies a staged restore, if there is one. Call before anything opens the config files.
 * The files being replaced are kept in `before-restore/` in case the backup was the wrong one.
 */
export function applyPendingRestore(configPath: string): boolean {
  const stage = join(configPath, STAGE_DIR);
  if (!existsSync(join(stage, READY))) {
    rmSync(stage, { recursive: true, force: true });
    return false;
  }
  const keep = join(configPath, 'before-restore');
  rmSync(keep, { recursive: true, force: true });
  mkdirSync(keep, { recursive: true, mode: 0o700 });
  for (const name of FILES) {
    const live = join(configPath, name);
    if (!existsSync(join(stage, name))) continue;
    if (existsSync(live)) renameSync(live, join(keep, name));
    renameSync(join(stage, name), live);
  }
  // The old database's journal must not be replayed onto the restored one.
  for (const suffix of ['-wal', '-shm'])
    rmSync(join(configPath, `draxmax.db${suffix}`), { force: true });
  rmSync(stage, { recursive: true, force: true });
  return true;
}
