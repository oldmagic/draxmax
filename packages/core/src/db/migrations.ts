/** Ordered schema migrations; index + 1 is the resulting `PRAGMA user_version`. Never edit a shipped entry. */
export const migrations: string[] = [
  `
  CREATE TABLE torrents (
    id               TEXT PRIMARY KEY,
    info_hash        TEXT NOT NULL UNIQUE,
    name             TEXT NOT NULL,
    magnet_uri       TEXT,
    torrent_file     BLOB,
    save_path        TEXT NOT NULL,
    paused           INTEGER NOT NULL DEFAULT 0,
    added_at         TEXT NOT NULL,
    completed_at     TEXT,
    category         TEXT,
    tags             TEXT NOT NULL DEFAULT '[]',
    sequential       INTEGER NOT NULL DEFAULT 0,
    priority         INTEGER NOT NULL DEFAULT 0,
    file_priorities  TEXT NOT NULL DEFAULT '[]',
    files            TEXT NOT NULL DEFAULT '[]',
    bitfield         BLOB,
    uploaded_base    INTEGER NOT NULL DEFAULT 0,
    downloaded_base  INTEGER NOT NULL DEFAULT 0,
    total_size       INTEGER NOT NULL DEFAULT 0,
    error            TEXT
  );
  CREATE TABLE kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE torrents ADD COLUMN trackers TEXT NOT NULL DEFAULT '[]';
  CREATE TABLE categories (
    name      TEXT PRIMARY KEY,
    save_path TEXT
  );
  `,
  `
  CREATE TABLE rss_feeds (
    id               TEXT PRIMARY KEY,
    url              TEXT NOT NULL UNIQUE,
    title            TEXT NOT NULL,
    enabled          INTEGER NOT NULL DEFAULT 1,
    refresh_minutes  INTEGER,
    last_fetched     TEXT,
    last_error       TEXT,
    next_fetch_at    TEXT,
    failures         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL
  );
  CREATE TABLE rss_articles (
    feed_id           TEXT NOT NULL REFERENCES rss_feeds(id) ON DELETE CASCADE,
    id                TEXT NOT NULL,
    title             TEXT NOT NULL,
    link              TEXT NOT NULL,
    torrent_url       TEXT,
    pub_date          TEXT NOT NULL,
    size              INTEGER,
    is_read           INTEGER NOT NULL DEFAULT 0,
    matched_rule_ids  TEXT NOT NULL DEFAULT '[]',
    fetched_at        TEXT NOT NULL,
    PRIMARY KEY (feed_id, id)
  );
  CREATE INDEX rss_articles_by_date ON rss_articles(feed_id, pub_date DESC);
  CREATE TABLE rss_rules (
    id                      TEXT PRIMARY KEY,
    name                    TEXT NOT NULL,
    enabled                 INTEGER NOT NULL DEFAULT 1,
    priority                INTEGER NOT NULL DEFAULT 0,
    must_contain            TEXT NOT NULL DEFAULT '[]',
    must_not_contain        TEXT NOT NULL DEFAULT '[]',
    use_regex               INTEGER NOT NULL DEFAULT 0,
    episode_filter          TEXT,
    smart_episode_filter    INTEGER NOT NULL DEFAULT 0,
    ignore_subsequent_days  INTEGER,
    assigned_feed_ids       TEXT NOT NULL DEFAULT '[]',
    category                TEXT,
    tags                    TEXT NOT NULL DEFAULT '[]',
    save_path               TEXT,
    add_paused              INTEGER NOT NULL DEFAULT 0,
    last_match_at           TEXT,
    created_at              TEXT NOT NULL
  );
  CREATE TABLE rss_downloads (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id        TEXT,
    rule_name      TEXT,
    feed_id        TEXT NOT NULL,
    article_id     TEXT NOT NULL,
    article_title  TEXT NOT NULL,
    torrent_url    TEXT,
    episode_keys   TEXT NOT NULL DEFAULT '[]',
    repack         INTEGER NOT NULL DEFAULT 0,
    torrent_id     TEXT,
    status         TEXT NOT NULL,
    error          TEXT,
    created_at     TEXT NOT NULL
  );
  CREATE INDEX rss_downloads_by_rule ON rss_downloads(rule_id);
  `,
  `
  CREATE TABLE library_entries (
    id             TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    type           TEXT NOT NULL,
    tmdb_id        INTEGER,
    anilist_id     INTEGER,
    seasons_owned  TEXT NOT NULL DEFAULT '[]',
    year           INTEGER,
    source         TEXT NOT NULL,
    hidden         INTEGER NOT NULL DEFAULT 0,
    lookup_done    INTEGER NOT NULL DEFAULT 0,
    updated_at     TEXT NOT NULL
  );
  CREATE TABLE upcoming_actions (
    item_id     TEXT PRIMARY KEY,
    action      TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE TABLE http_cache (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE stats_samples (
    t     INTEGER PRIMARY KEY,
    down  REAL NOT NULL,
    up    REAL NOT NULL
  );
  `,
  `
  ALTER TABLE torrents ADD COLUMN seeding_seconds INTEGER NOT NULL DEFAULT 0;
  `,
  `
  CREATE TABLE sites (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    preset        TEXT,
    enabled       INTEGER NOT NULL DEFAULT 1,
    base_urls     TEXT NOT NULL DEFAULT '[]',
    search_urls   TEXT NOT NULL DEFAULT '[]',
    info_url      TEXT NOT NULL DEFAULT '',
    download_url  TEXT NOT NULL DEFAULT '',
    mapping       TEXT NOT NULL DEFAULT '{}',
    fields        TEXT NOT NULL DEFAULT '[]',
    secrets       TEXT NOT NULL DEFAULT '',
    last_test     TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE sites ADD COLUMN must_match TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE sites ADD COLUMN must_not_match TEXT NOT NULL DEFAULT '[]';
  `,
  `
  CREATE TABLE notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category    TEXT NOT NULL,
    level       TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT,
    link        TEXT,
    dedupe_key  TEXT,
    count       INTEGER NOT NULL DEFAULT 1,
    read        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX notifications_by_read ON notifications(read, id);
  CREATE INDEX notifications_by_key ON notifications(dedupe_key);
  `,
  `
  ALTER TABLE torrents ADD COLUMN complete_path TEXT;
  ALTER TABLE torrents ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE torrents ADD COLUMN seed_exempt INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE rss_rules ADD COLUMN missing_mode TEXT NOT NULL DEFAULT 'default';
  ALTER TABLE sites ADD COLUMN content_types TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE sites ADD COLUMN category TEXT;
  ALTER TABLE categories ADD COLUMN seed_minutes INTEGER;
  ALTER TABLE categories ADD COLUMN seed_ratio REAL;
  CREATE TABLE sessions (
    id_hash     TEXT PRIMARY KEY,
    expires_at  INTEGER NOT NULL
  );
  `,
];
