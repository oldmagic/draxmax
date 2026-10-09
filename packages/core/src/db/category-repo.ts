import type { Database } from './database.ts';

export interface Category {
  name: string;
  /** Default save path for new torrents in this category; null = global default. */
  savePath: string | null;
}

/** CRUD for the `categories` table. */
export class CategoryRepository {
  constructor(private readonly db: Database) {}

  all(): Category[] {
    const rows = this.db
      .prepare('SELECT name, save_path FROM categories ORDER BY name COLLATE NOCASE')
      .all() as {
      name: string;
      save_path: string | null;
    }[];
    return rows.map((r) => ({ name: r.name, savePath: r.save_path }));
  }

  get(name: string): Category | null {
    const r = this.db.prepare('SELECT name, save_path FROM categories WHERE name = ?').get(name) as
      { name: string; save_path: string | null } | undefined;
    return r ? { name: r.name, savePath: r.save_path } : null;
  }

  save(c: Category): void {
    this.db
      .prepare(
        'INSERT INTO categories (name, save_path) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET save_path = excluded.save_path',
      )
      .run(c.name, c.savePath);
  }

  delete(name: string): void {
    this.db.prepare('DELETE FROM categories WHERE name = ?').run(name);
  }
}
