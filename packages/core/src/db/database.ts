import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrations } from './migrations.ts';

export type Database = DatabaseSync;

/**
 * Opens (creating if needed) the SQLite database and applies pending migrations.
 * Uses Node's built-in `node:sqlite`, so the same file works in Node and Electron
 * without native-module rebuilds.
 */
export function openDatabase(path: string): Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
    // Owner-only: it holds feed URLs with tracker passkeys. SQLite gives the -wal/-shm files
    // the same permissions as the database.
    closeSync(openSync(path, 'a', 0o600));
    try {
      chmodSync(path, 0o600);
    } catch {
      // Filesystems without POSIX modes (some network shares): best effort.
    }
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const current = row.user_version;
  for (let v = current; v < migrations.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
