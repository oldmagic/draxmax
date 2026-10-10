# DraxMax

A modern, easy-to-run BitTorrent client written in TypeScript. One core powers a **desktop app** (Electron), a **headless daemon with a Web UI**, and an **official Docker image**.

- **Downloads:** magnets and `.torrent` files (paste or drop anywhere), file selection and priorities, sequential mode, categories and tags, a download queue, per-torrent and global trackers, reannounce/recheck, moving data to another folder, an optional folder for unfinished downloads, seeding limits by time or ratio, and fast resume after restarts.
- **Search:** one search box over your tracker sites, Torznab indexers (Prowlarr/Jackett) and the built-in anime indexers. Add a result, or **Follow** a show to get a ready-made download rule.
- **RSS:** feeds with advanced rules (wildcards or regex, qBittorrent-style episode filters, smart duplicate detection, per-feed assignment, ignore-days), a live "would match" preview, and download history.
- **Upcoming:** *For You* surfaces the next season of shows you have, sequels to anime you watch and other films in collections you own. *New Releases* lists popular upcoming and airing titles. Data comes from TMDB and AniList.
- **Stats:** live and 24-hour bandwidth charts, session and all-time totals, network health, disk usage and top consumers.
- **Works with Sonarr and Radarr:** add DraxMax to them as a "qBittorrent" download client.
- **Polish:** a 60-second first-run wizard, dark/light/system themes, keyboard shortcuts (`?`), tray and notifications on desktop, notifications to your phone (ntfy, Discord, Telegram, any webhook), one-file backup and restore, and a login for remote Web UI access.

## Quick start

### Docker (servers, NAS, seedboxes)

```bash
cp .env.example .env                 # optional: PUID/PGID, listen address, login, TMDB key…
mkdir -p data/config data/watch      # must exist and belong to you: the container never runs as root
docker compose up -d --build
# open http://localhost:8895
```

- **Volumes:** `/config` holds the database, settings and keys. `/watch` is a drop folder: put `.torrent` or `.magnet` files there to add them. The compose file mounts the host's `/media` at `/media` as the default save folder (`DOWNLOAD_PATH`); change that mount and variable to wherever your drives are.
- **User:** the container runs as `PUID:PGID` (default `1000:1000`) from its first instruction, with no capabilities and a read-only root filesystem. `data/config` and your save folders must be writable by that user. If you'd rather let the container fix ownership and switch users itself (Settings → *Run as*), see the comment in `docker-compose.yml`.
- **Listen address:** with host networking the Web UI listens on every interface. Set `HOST` in `.env` to your LAN address to keep it off the others.
- **Healthcheck:** `/api/health`. On `docker stop`, resume data is flushed before exit.
- **Other folders and network shares:** the container only sees folders you mount into it. Mount the share on the host first (NFS/SMB via `/etc/fstab`, or your NAS's own share), then add it as a volume, for example `- /mnt/nas/media:/nas`. It then appears in the folder browser as `/nas`. The `PUID`/`PGID` user must be able to write to it.

**Networking.** `network_mode: host` (the default in `docker-compose.yml`) gives the best peer and DHT connectivity on Linux. On Docker Desktop (macOS/Windows), use the commented `ports:` block and publish:

| Port       | Purpose                                          |
| ---------- | ------------------------------------------------ |
| `8895/tcp` | Web UI + API (`PORT`)                            |
| `6881/tcp` | BitTorrent peers (`TORRENT_PORT`)                |
| `6881/udp` | uTP peers (same as `TORRENT_PORT`)               |
| `6882/udp` | DHT (`DHT_PORT`, defaults to `TORRENT_PORT + 1`) |

For the best speeds, forward `TORRENT_PORT` on your router, or leave UPnP on.

**With the *arr stack:** [`examples/docker-compose.arr.yml`](examples/docker-compose.arr.yml) runs DraxMax next to Sonarr, Radarr, Prowlarr and Jellyfin with a shared `/data` tree. Add your library folders under *Settings → Upcoming & media* so *For You* knows what you own.

**Development container** (hot reload, Web UI on `:5173`): `docker compose -f docker-compose.dev.yml up`.

### Desktop app

```bash
pnpm install
pnpm dev:desktop             # run from source
pnpm build:desktop           # installers in apps/desktop/release (AppImage + deb on Linux, NSIS on Windows, dmg on macOS)
pnpm build:desktop:dir       # unpacked app only (fast)
```

The desktop app:

- embeds the same server on `127.0.0.1`, with a random port and a per-launch token
- keeps seeding in the tray when the window is closed (configurable)
- shows native notifications and can start at login
- registers as the handler for `magnet:` links and `.torrent` files
- stores secrets with the OS keychain (Electron `safeStorage`) when one is available

### Headless, from source

```bash
pnpm install
pnpm build
pnpm start                   # http://localhost:8895
```

## Configuration

Everything is configurable in **Settings**. Every value can also be set by an environment variable, which takes precedence and shows as locked in the UI. Values are stored in `settings.json` in the config directory, and secrets (API keys) are encrypted at rest.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` / `HOST` | `8895` / `0.0.0.0` | Web UI + API listen address |
| `CONFIG_PATH` | `./data/config` | SQLite database, `settings.json`, `secret.key` |
| `DOWNLOAD_PATH` | `./data/downloads` | Default save folder |
| `INCOMPLETE_PATH` | | Unfinished downloads live here and move to their save folder when done |
| `MIN_FREE_SPACE_MB` | `512` | Downloads stop when their drive has less free space; `0` = never |
| `SEED_TIME_LIMIT_MINUTES` / `SEED_LIMIT_ACTION` | `0` / `remove` | Seeding time limit; at a limit the torrent is removed from the list or just stopped (`pause`). A ratio limit and per-category limits are in Settings |
| `WATCH_PATH` | *(off; `/watch` in Docker)* | Folder polled for `.torrent` / `.magnet` files |
| `WEBUI_USERNAME` / `WEBUI_PASSWORD` | | Web UI login (otherwise created in the UI) |
| `API_TOKEN` | | Token for scripts: `Authorization: Bearer <token>` |
| `AUTH_DISABLED` | `false` | Only behind a reverse proxy that does its own authentication |
| `MAX_ACTIVE_DOWNLOADS` | `5` | `0` = unlimited; the rest wait as *queued* |
| `TORRENT_PORT` | `6881` | TCP + uTP; `0` = random |
| `DHT_PORT` | `TORRENT_PORT + 1` | Must differ from `TORRENT_PORT` |
| `MAX_CONNECTIONS` | `55` | Per torrent |
| `DOWNLOAD_LIMIT` / `UPLOAD_LIMIT` | `-1` | Bytes/s; `-1` = unlimited (applied live) |
| `ENABLE_DHT` / `ENABLE_PEX` / `ENABLE_LSD` | `true` | Turn off for private trackers / anonymous mode |
| `ENABLE_UPNP` / `ENABLE_NATPMP` | `true` | |
| `ENCRYPTION` | `1` | `0` off, `1` prefer, `2` require |
| `DEFAULT_TRACKERS` | a few public trackers | Comma- or newline-separated |
| `ADD_DEFAULT_TRACKERS` | `false` | Append them to every new torrent |
| `RSS_ENABLED` / `RSS_REFRESH_MINUTES` | `true` / `30` | |
| `MISSING_ENABLED` / `MISSING_INTERVAL_HOURS` | `true` / `6` | Search for episodes your rule folders lack (see *Missing episodes*) |
| `MISSING_WHEN_EMPTY` | `wait` | A rule folder without episodes waits for RSS, or (`download`) is filled from episode 1 |
| `MISSING_USE_NYAA` / `MISSING_USE_ANIMETOSHO` | `true` / `true` | Built-in anime search sources (also under Sites → Indexers) |
| `TORZNAB_URLS` | | Prowlarr/Jackett Torznab URLs with `apikey=`, space-separated; needed for live-action TV |
| `MISSING_MIN_SEEDERS` / `MISSING_MAX_PER_RUN` | `1` / `25` | Skip dead releases; cap torrents added per run |
| `TMDB_API_KEY` | | Free at [themoviedb.org](https://www.themoviedb.org/settings/api); v3 key or v4 token |
| `ANILIST_ENABLED` / `ANILIST_TOKEN` | `true` / | AniList works without a token |
| `LIBRARY_FOLDERS` | | Media folders scanned for *For You* |
| `SEARCH_URL_TEMPLATE` | | "Search & Add" target, e.g. `https://example.org/search?q={query}` |
| `NOTIFY_WEBHOOK_URL` | | Phone/chat notifications: an ntfy topic, Discord webhook, Telegram bot URL or any JSON webhook |
| `LOG_LEVEL` | `info` | `error`…`trace`, `silent`. Individual requests are logged at `debug` |
| `PUID` / `PGID` | `1000` | Docker only: the user the container runs as |

### Security model

- **No login configured:** only the local machine (loopback, not proxied, addressed by IP, `localhost` or its own name) can use DraxMax. Any other device is shown a "Secure your DraxMax" screen and must create a login first, using the one-time **setup code** printed in the log (`docker logs draxmax`), so nobody else can claim a fresh instance.
- **Cross-site protection:** state-changing API calls and WebSocket connections from other websites are refused (Origin / Sec-Fetch-Site checks), and DNS-rebinding hostnames don't count as the local machine.
- **Changing the login** needs the current password. Removing it is only possible on the DraxMax machine itself.
- **Network fetches:** links taken from feeds and search results may only reach public addresses, unless they point at the feed's own host (e.g. Prowlarr on your LAN). Redirects are checked hop by hop, and each request connects to the address that was checked (no second DNS lookup to rebind).
- **Torrents** whose file paths would escape the save folder (`..`, absolute or Windows paths) are refused.
- **Files:** the config folder is `0700`; `settings.json`, `secret.key` and the database are `0600`. API tokens are redacted from logs.
- **Login configured:** every client needs a session. Sessions are HttpOnly, SameSite=Strict cookies. Passwords are hashed with scrypt, and repeated failed logins are rate-limited. Sessions survive a restart (only their hashes are stored) and all end when the login changes; signing out also closes that session's live connection.
- **Private torrents** never get the default public trackers added, also when "add default trackers to every new torrent" is on.
- **API token** is accepted as an `Authorization: Bearer` header only (the WebSocket handshake, which can't send headers, is the one exception). `/api/health` is public but reveals nothing unless you are signed in.
- **Backups** contain your passkeys and the key that decrypts stored secrets, so downloading or restoring one asks for the current password again.
- **Headers:** responses carry a strict Content-Security-Policy, `nosniff`, no-referrer and frame-deny.
- **Privacy:** DraxMax never phones home. The only outbound calls besides BitTorrent traffic are the RSS feeds you add and, if enabled, TMDB and AniList.

## Using it

- **Search** (sidebar, or press `/`): type a title and pick *Everything*, *Anime*, *TV* or *Movies*. Every enabled site and indexer that carries that kind is asked.
  - **Add** sends a result to the download list (optionally into a category).
  - **Follow** opens a new download rule for that show, prefilled with its name, release group and resolution, and with the folder, category and feeds your existing rules of the same kind use. Check it and save. The same button is on every RSS article.
- **Add torrents:** paste a magnet link anywhere (Ctrl/⌘+V), drop `.torrent` files onto the window, press `N`, or use **Add**. In the add dialog, **Save to** picks a folder for just these torrents (type a path or **Browse** the server's folders, with recent and category folders one click away). Leave it empty to use the category's folder or the default. The dialog's options set the category, tags, paused start and sequential mode.
- **Manage torrents:** click to select, Shift- or Ctrl-click for several, right-click for every action. Double-click (or Enter) opens details with General, Files, Trackers and Peers tabs.
  - **Move to another folder…** moves the files (a copy when it's another drive) and continues from there. Turn *Move the files there* off if you moved them yourself.
  - **Seeding limits** (*Settings → Downloads*): stop after a time and/or at a ratio, and choose whether a torrent that reaches its limit is stopped or removed from the list. A category can have its own limits, e.g. a longer minimum for a private tracker. Resuming a stopped torrent by hand lets it seed on.
  - **Folder for unfinished downloads:** downloads stay there and move to their save folder when complete.
  - Downloads stop, with a clear error, when their drive is nearly full.
- **RSS rules:**
  - *Must contain* lines are alternatives. Words in a line must all appear; `*`/`?` are wildcards and `|` separates alternatives.
  - The episode filter takes `1x01-1x10;2x05;3x-` (open ranges also include later seasons).
  - The smart filter never downloads the same episode twice. A REPACK/PROPER is allowed once.
  - Saving a rule also applies it to articles already in your feeds.
  - **Feeds for many rules at once:** tick rules (Shift-click for a range, or search and tick the box at the top for all shown). The right-hand panel then lists every feed as on, off or mixed for the selection: click to add a feed to all of them or remove it, then *Save feeds*. Disabled rules can be turned on in the same step.
  - **Edit as JSON** (top of the RSS page) shows all feeds and rules as one document: rules list their feeds by URL, and keeping a rule's `id` lets you rename it. Errors point to the line, saving is all-or-nothing and never downloads a backlog, and *Delete feeds and rules that aren't in the JSON* is off unless you tick it.
  - Each rule can save to its own folder (*Save to*), e.g. `/media/Anime/<Show>/S01`. The checkbox in the rule list turns a rule on or off.
  - **Coming from qBittorrent?** Export your rules there (RSS → Download Rules… → right-click the list → *Export rules…*). Then use the import button above the rule list. Feeds are matched by URL, and missing ones can be added for you. Rules that end up without a subscribed feed are imported disabled. By default only future articles are downloaded. qBittorrent's per-rule list of already-matched episodes isn't imported.
- **Missing episodes:** RSS only sees the latest items in a feed, so episodes released while DraxMax was off, or before you added a rule, never arrive that way. Every enabled rule with a *Save to* folder is checked regularly, every 6 h for shows active in the last 30 days and weekly for the rest:
  - DraxMax reads the folder to learn the show, the season and the episodes you have. Torrents in the client and the rule's download history count too.
  - It searches Nyaa, AnimeTosho and your Torznab indexers with the rule's own text, and accepts only results that pass the rule's filters, so the group and quality stay the same.
  - It adds every released episode after the first one you have, so episodes you watched and deleted before that aren't fetched again.
  - **Empty folders:** by default a rule whose folder has no episodes waits for its first one from RSS. *Settings → RSS → When a rule's folder has no episodes yet* can fetch the season from episode 1 instead.
  - **Per rule:** the rule editor's *Missing episodes* option overrides this: follow the setting, fill gaps only, fetch the whole season from episode 1, or don't search for this rule at all.
  - A batch is used only when every episode in it is missing. Releases with no seeders wait for the next check.
  - **RSS → Missing episodes** shows the status for each show and has *Check all now*.
- **Sites** (sidebar, `g` then `i`): everything DraxMax searches, used by Search and by the missing-episode check.
  - **Indexers** (bottom of the list): turn the built-in anime indexers (Nyaa, AnimeTosho) on or off, and add Prowlarr/Jackett Torznab feed URLs. API keys are stored encrypted and never shown again. The flask button tests a source.
  - **What this site carries:** tick Anime, TV shows and/or Movies and the site is only searched for those, so an anime rule doesn't query a general tracker. Leave all unticked to search it for everything.
  - **Download category:** torrents found on a site get this category when the rule doesn't set one.
  - **Add site** offers ~110 known trackers (SuperBits, IPTorrents, TorrentLeech, BTN, …), with their URLs, login fields and torrent/download link patterns filled in, or a custom site.
  - Enter the passkey (and other login fields), the **session cookies** (paste the `Cookie` header from your browser), and optional extra headers. They're stored encrypted and never shown again.
  - **Search URLs** take `{query}`, e.g. `/search?search={query}`. Several can be listed; they're tried in order. JSON APIs, HTML search pages (found by the torrent-page link pattern, e.g. `/torrent/{id}/`) and RSS/Torznab are detected automatically. **Test search** shows what was found, and JSON field names can be set under *Result reading*.
  - **Release filters** per site: *Must match* and *Must not match* regexes (case-insensitive, one per line) decide what that site may download. For example, `-(EGEN|NORViNE)$` takes only those groups and `\b(HD)?CAM\b` blocks cams. Test search marks what they keep.
  - Download links are built from the pattern, e.g. `/download.php?id={id}&passkey={passkey}`. A site's cookies are sent only to its own URLs, which also covers its RSS feeds.
  - Site facts come from the [autobrr](https://github.com/autobrr/autobrr) indexer definitions; regenerate them with `node scripts/gen-site-presets.mjs`.
- **Notifications:** the bell (top of the sidebar, `g` then `n` for the full page) keeps a history of what happened. That covers torrents added (and from where), finished, failed or seeded; RSS and missing-episode downloads; feeds or site searches that start failing; new seasons in For You; sign-ins and failed logins; settings changes; and engine problems.
  - Repeats within 10 minutes are combined (`×4`).
  - Mark items read or unread one by one, in bulk, or all at once. Filter by kind or search.
  - It's stored on the server, so every device sees the same list.
  - *Settings → Notifications* sets how long it's kept and which kinds are recorded.
  - **On your phone:** paste a notification URL there (an ntfy topic such as `https://ntfy.sh/your-topic`, a Discord webhook, a Telegram bot `sendMessage?chat_id=…` URL, or any URL that accepts a JSON POST) to get finished downloads, failures, RSS downloads and failed logins without a browser tab open. *Send a test* checks it.
- **Sonarr / Radarr / Prowlarr:** add DraxMax as a **qBittorrent** download client (host, port 8895, your Web UI login; no login is needed from the same machine if you haven't set one). Set *When a seeding limit is reached* to *Stop the torrent* so finished downloads stay in the list until they're imported. See [`examples/docker-compose.arr.yml`](examples/docker-compose.arr.yml).
- **Backup and restore** (*Settings → Advanced*): one file with settings, rules, feeds, sites, torrents and history. Restoring replaces everything on the next start and keeps the previous state in the config folder under `before-restore`.
- **Speed schedule** (*Settings → Speed limits*): different limits between two times of day.
- **Upcoming:** "Already have" teaches the library, and "Ignore" hides an item; both can be undone. "Search & Add" opens your search site, or copies a ready-made query such as `The Expanse S05`.
- **Keyboard:** `?` lists every shortcut. `/` opens Search. `g` then `d`/`f`/`u`/`r`/`i`/`n`/`s`/`,` jumps between pages.

## Architecture

```
packages/shared   Domain types (spec §5), zod request schemas, WebSocket event contract
packages/core     UI-agnostic services, composed in createCore():
                    torrent/  TorrentManager (queue, trackers, resume, seeding limits, moving data) + TorrentEngine (WebTorrent adapter)
                    missing/  missing-episode check and the search sources (Nyaa, AnimeTosho, Torznab)
                    sites/    tracker sites: credentials, search pages, release filters
                    search/   search over all sources; managing indexers
                    rss/      feed fetcher/parser, rule engine (pure), scheduler, history
                    media/    release-name parser, library fingerprint, TMDB + AniList clients, Upcoming ranking
                    stats/    1 s sampling, per-minute history, all-time totals
                    watch/    watch-folder poller
                    settings/ zod-validated settings + env overrides + encrypted secrets
                    db/       node:sqlite with migrations
apps/server       Fastify REST + WebSocket API, auth, security headers, qBittorrent-compatible API (/api/v2);
                  serves the Web UI; headless entry
apps/web          React 19 + Vite + Tailwind v4 + Radix + TanStack Query + Zustand + Motion
apps/desktop      Electron shell (tray, notifications, keychain, file associations) embedding core + server
e2e/              Playwright smoke tests against the production server bundle
```

- **One API surface.** The desktop app talks to its embedded server over HTTP and WebSocket, exactly like a browser. Preload IPC is used only for native pickers and opening folders.
- **Engine abstraction.** `TorrentManager` only knows the `TorrentEngine` interface. `FakeEngine` (`@draxmax/core/testing`) drives the tests.
- **Persistence.** Built-in `node:sqlite`, so no native database module needs rebuilding for Electron. Resume data of torrents that transferred something is saved every 30 s, and everything on shutdown, so restarts only spot-check pieces.
- **Live updates.** The torrent list is pushed once a second as a delta: each torrent is serialised once and only the ones that changed are sent. A client that falls behind is skipped and resynchronised with a full snapshot.
- **Pausing** fully stops a torrent; WebTorrent's own pause only stops new connections. Changing trackers restarts the torrent with exactly the configured list.

### Known engine limitations (WebTorrent)

- BitTorrent v2-only torrents and magnets aren't supported (v1 and hybrid are).
- There are no per-torrent speed limits (the engine throttles globally); global limits and the speed schedule apply live.
- Proxy, VPN interface binding and a kill-switch aren't available: the engine can't bind its sockets to one interface, and a switch that doesn't cover every socket would be worse than none. Use your VPN's own kill-switch or a VPN container's network.
- A category's save folder applies to newly added torrents; use *Move to another folder…* for existing ones.
- `patches/webtorrent@3.0.21.patch` fixes a crash when utp-native emits `error` twice on a socket and a quadratic piece-picker scan; `patches/bittorrent-protocol@5.0.9.patch` makes the encryption handshake cheap. These two are the only files in `patches/`.

## Development

```bash
pnpm dev            # API on :8895 (tsx watch) + Vite on :5173 with proxy and HMR
pnpm test           # unit + integration (Vitest)
pnpm test:e2e       # Playwright (run `pnpm build` first)
pnpm typecheck
pnpm lint
```

CI (`.github/workflows`) runs a dependency audit, lint, typecheck, tests, build, E2E and a Docker smoke test on every push. Actions and base images are pinned by commit/digest, and Dependabot keeps them and the dependencies current. Tags `v*` publish a multi-arch image to GHCR and build the desktop installers.

## Legal

DraxMax is a general-purpose BitTorrent client. Only download and share content you have the right to.
