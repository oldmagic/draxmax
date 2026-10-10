import type { Database } from './database.ts';

export interface Category {
  name: string;
  /** Default save path for new torrents in this category; null = global default. */
  savePath: string | null;
  /** Seeding limits for this category; null = the global setting, 0 = no limit. */
  seedMinutes?: number | null;
  seedRatio?: number | null;
}

interface Row {
  name: string;
  save_path: string | null;
  seed_minutes: number | null;
  seed_ratio: number | null;
}

const fromRow = (r: Row): Category => ({
  name: r.name,
  savePath: r.save_path,
  seedMinutes: r.seed_minutes,
  seedRatio: r.seed_ratio,
});

/** CRUD for the `categories` table. Reads are cached: the manager looks categories up every tick. */
export class CategoryRepository {
  private cache: Category[] | null = null;

  constructor(private readonly db: Database) {}

  all(): Category[] {
    this.cache ??= (
      this.db
        .prepare(
          'SELECT name, save_path, seed_minutes, seed_ratio FROM categories ORDER BY name COLLATE NOCASE',
        )
        .all() as unknown as Row[]
    ).map(fromRow);
    return this.cache;
  }

  get(name: string): Category | null {
    return this.all().find((c) => c.name === name) ?? null;
  }

  save(c: Category): void {
    this.db
      .prepare(
        `INSERT INTO categories (name, save_path, seed_minutes, seed_ratio) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET save_path = excluded.save_path,
           seed_minutes = excluded.seed_minutes, seed_ratio = excluded.seed_ratio`,
      )
      .run(c.name, c.savePath, c.seedMinutes ?? null, c.seedRatio ?? null);
    this.cache = null;
  }

  delete(name: string): void {
    this.db.prepare('DELETE FROM categories WHERE name = ?').run(name);
    this.cache = null;
  }
}
