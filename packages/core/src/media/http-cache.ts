import type { Database } from '../db/database.ts';

/** Small TTL cache in SQLite for metadata API responses. */
export class HttpCache {
  constructor(private readonly db: Database) {}

  get<T>(key: string): T | undefined {
    const row = this.db
      .prepare('SELECT value, expires_at FROM http_cache WHERE key = ?')
      .get(key) as { value: string; expires_at: number } | undefined;
    if (!row || row.expires_at < Date.now()) return undefined;
    return JSON.parse(row.value) as T;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    this.db
      .prepare(
        'INSERT INTO http_cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
      )
      .run(key, JSON.stringify(value), Date.now() + ttlMs);
  }

  /** Returns the cached value or computes, stores and returns it. */
  async wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.get<T>(key);
    if (hit !== undefined) return hit;
    const value = await fn();
    this.set(key, value, ttlMs);
    return value;
  }

  prune(): void {
    this.db.prepare('DELETE FROM http_cache WHERE expires_at < ?').run(Date.now());
  }

  clear(prefix: string): void {
    this.db.prepare('DELETE FROM http_cache WHERE key LIKE ?').run(`${prefix}%`);
  }
}
