# DraxMax

A modern, easy-to-run BitTorrent client written in TypeScript. One core powers a **desktop app** (Electron), a **headless daemon with a Web UI**, and an **official Docker image**.

- **Downloads:** magnets and `.torrent` files (paste or drop anywhere), file selection and priorities, sequential mode, categories and tags, a download queue, per-torrent and global trackers, reannounce/recheck, and fast resume after restarts.
- **RSS:** feeds with advanced rules (wildcards or regex, qBittorrent-style episode filters, smart duplicate detection, per-feed assignment, ignore-days), a live "would match" preview, and download history.
- **Upcoming:** *For You* surfaces the next season of shows you have, sequels to anime you watch and other films in collections you own. *New Releases* lists popular upcoming and airing titles. Data comes from TMDB and AniList.
- **Stats:** live and 24-hour bandwidth charts, session and all-time totals, network health, disk usage and top consumers.
- **Polish:** a 60-second first-run wizard, dark/light/system themes, keyboard shortcuts (`?`), tray and notifications on desktop, and a login for remote Web UI access.

## Quick start

### Docker (servers, NAS, seedboxes)

```bash
cp .env.example .env                              # optional: PUID/PGID, login, TMDB key…
mkdir -p data/config data/downloads data/watch    # otherwise Docker creates ./data owned by root
docker compose up -d --build
# open http://localhost:8895
```

- **Volumes:** `/config` holds the database, settings and keys. `/downloads` holds your data. `/watch` is a drop folder: put `.torrent` or `.magnet` files there to add them.
- **User:** the container starts as root only long enough to apply `PUID`/`PGID` and fix volume ownership, then runs unprivileged.
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
| `WATCH_PATH` | *(off; `/watch` in Docker)* | Folder polled for `.torrent` / `.magnet` files |
| `WEBUI_USERNAME` / `WEBUI_PASSWORD` | | Web UI login (otherwise created in the UI) |
| `API_TOKEN` | | Token for scripts: `Authorization: Bearer <token>` or `?token=` |
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
| `MISSING_USE_NYAA` / `MISSING_USE_ANIMETOSHO` | `true` / `true` | Built-in anime search sources |
| `TORZNAB_URLS` | | Prowlarr/Jackett Torznab URLs with `apikey=`, space-separated; needed for live-action TV |
| `MISSING_MIN_SEEDERS` / `MISSING_MAX_PER_RUN` | `1` / `25` | Skip dead releases; cap torrents added per run |
| `TMDB_API_KEY` | | Free at [themoviedb.org](https://www.themoviedb.org/settings/api); v3 key or v4 token |
| `ANILIST_ENABLED` / `ANILIST_TOKEN` | `true` / | AniList works without a token |
| `LIBRARY_FOLDERS` | | Media folders scanned for *For You* |
| `SEARCH_URL_TEMPLATE` | | "Search & Add" target, e.g. `https://example.org/search?q={query}` |
| `LOG_LEVEL` | `info` | `error`…`trace`, `silent` |
| `PUID` / `PGID` | `1000` | Docker only |

### Security model

- **No login configured:** only the local machine (loopback, not proxied, addressed by IP, `localhost` or its own name) can use DraxMax. Any other device is shown a "Secure your DraxMax" screen and must create a login first, using the one-time **setup code** printed in the log (`docker logs draxmax`), so nobody else can claim a fresh instance.
- **Cross-site protection:** state-changing API calls and WebSocket connections from other websites are refused (Origin / Sec-Fetch-Site checks), and DNS-rebinding hostnames don't count as the local machine.
- **Changing the login** needs the current password. Removing it is only possible on the DraxMax machine itself.
- **Network fetches:** links taken from feeds and search results may only reach public addresses, unless they point at the feed's own host (e.g. Prowlarr on your LAN). Redirects are checked hop by hop.
- **Torrents** whose file paths would escape the save folder (`..`, absolute or Windows paths) are refused.
- **Files:** the config folder is `0700`; `settings.json`, `secret.key` and the database are `0600`. API tokens are redacted from logs.
- **Login configured:** every client needs a session. Sessions are HttpOnly, SameSite=Strict cookies. Passwords are hashed with scrypt, and repeated failed logins are rate-limited.
- **Headers:** responses carry a strict Content-Security-Policy, `nosniff`, no-referrer and frame-deny.
- **Privacy:** DraxMax never phones home. The only outbound calls besides BitTorrent traffic are the RSS feeds you add and, if enabled, TMDB and AniList.

## Using it

- **Add torrents:** paste a magnet link anywhere (Ctrl/⌘+V), drop `.torrent` files onto the window, press `N`, or use **Add**. In the add dialog, **Save to** picks a folder for just these torrents (type a path or **Browse** the server's folders, with recent and category folders one click away). Leave it empty to use the category's folder or the default. The dialog's options set the category, tags, paused start and sequential mode.
- **Manage torrents:** click to select, Shift- or Ctrl-click for several, right-click for every action. Double-click (or Enter) opens details with General, Files, Trackers and Peers tabs.
- **RSS rules:**
  - *Must contain* lines are alternatives. Words in a line must all appear; `*`/`?` are wildcards and `|` separates alternatives.
  - The episode filter takes `1x01-1x10;2x05;3x-` (open ranges also include later seasons).
  - The smart filter never downloads the same episode twice. A REPACK/PROPER is allowed once.
  - Saving a rule also applies it to articles already in your feeds.
  - **Feeds for many rules at once:** tick rules (Shift-click for a range, or search and tick the box at the top for all shown). The right-hand panel then lists every feed as on, off or mixed for the selection: click to add a feed to all of them or remove it, then *Save feeds*. Disabled rules can be turned on in the same step.
  - **Edit as JSON** (top of the RSS page) shows all feeds and rules as one document: rules list their feeds by URL, and keeping a rule's `id` lets you rename it. Errors point to the line, saving is all-or-nothing and never downloads a backlog, and *Delete feeds and rules that aren't in the JSON* is off unless you tick it.
  - Each rule can save to its own folder (*Save to*), e.g. `/downloads/Anime/<Show>/S01`. The checkbox in the rule list turns a rule on or off.
  - **Coming from qBittorrent?** Export your rules there (RSS → Download Rules… → right-click the list → *Export rules…*). Then use the import button above the rule list. Feeds are matched by URL, and missing ones can be added for you. Rules that end up without a subscribed feed are imported disabled. By default only future articles are downloaded. qBittorrent's per-rule list of already-matched episodes isn't imported.
- **Missing episodes:** RSS only sees the latest items in a feed, so episodes released while DraxMax was off, or before you added a rule, never arrive that way. Every enabled rule with a *Save to* folder is checked regularly, every 6 h for shows active in the last 30 days and weekly for the rest:
  - DraxMax reads the folder to learn the show, the season and the episodes you have. Torrents in the client and the rule's download history count too.
  - It searches Nyaa, AnimeTosho and your Torznab indexers with the rule's own text, and accepts only results that pass the rule's filters, so the group and quality stay the same.
  - It adds every released episode after the first one you have, so episodes you watched and deleted before that aren't fetched again.
  - A batch is used only when every episode in it is missing. Releases with no seeders wait for the next check.
  - **RSS → Missing episodes** shows the status for each show and has *Check all now*.
- **Sites** (sidebar, `g` then `i`): tracker logins and search pages, used as extra search sources for missing episodes.
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
- **Upcoming:** "Already have" teaches the library, and "Ignore" hides an item; both can be undone. "Search & Add" opens your search site, or copies a ready-made query such as `The Expanse S05`.
- **Keyboard:** `?` lists every shortcut. `g` then `d`/`u`/`r`/`s`/`,` jumps between pages.

## Architecture

```
packages/shared   Domain types (spec §5), zod request schemas, WebSocket event contract
packages/core     UI-agnostic services, composed in createCore():
                    torrent/  TorrentManager (queue, trackers, resume) + TorrentEngine (WebTorrent adapter)
                    rss/      feed fetcher/parser, rule engine (pure), scheduler, history
                    media/    release-name parser, library fingerprint, TMDB + AniList clients, Upcoming ranking
                    stats/    1 s sampling, per-minute history, all-time totals
                    watch/    watch-folder poller
                    settings/ zod-validated settings + env overrides + encrypted secrets
                    db/       node:sqlite with migrations
apps/server       Fastify REST + WebSocket API, auth, security headers; serves the Web UI; headless entry
apps/web          React 19 + Vite + Tailwind v4 + Radix + TanStack Query + Zustand + Motion
apps/desktop      Electron shell (tray, notifications, keychain, file associations) embedding core + server
e2e/              Playwright smoke tests against the production server bundle
```

- **One API surface.** The desktop app talks to its embedded server over HTTP and WebSocket, exactly like a browser. Preload IPC is used only for native pickers and opening folders.
- **Engine abstraction.** `TorrentManager` only knows the `TorrentEngine` interface. `FakeEngine` (`@draxmax/core/testing`) drives the tests.
- **Persistence.** Built-in `node:sqlite`, so no native database module needs rebuilding for Electron. Resume bitfields are saved every 30 s and on shutdown, so restarts only spot-check pieces.
- **Pausing** fully stops a torrent; WebTorrent's own pause only stops new connections. Changing trackers restarts the torrent with exactly the configured list.

### Known engine limitations (WebTorrent)

- BitTorrent v2-only torrents and magnets aren't supported (v1 and hybrid are).
- There are no per-torrent speed limits; global limits apply live.
- Proxy, VPN interface binding and a kill-switch aren't available yet.
- Moving a torrent's data to another folder isn't supported yet. A category's save folder applies to newly added torrents.
- `patches/webtorrent@3.0.21.patch` fixes a crash when utp-native emits `error` twice on a socket.

## Development

```bash
pnpm dev            # API on :8895 (tsx watch) + Vite on :5173 with proxy and HMR
pnpm test           # unit + integration (Vitest)
pnpm test:e2e       # Playwright (run `pnpm build` first)
pnpm typecheck
pnpm lint
```

CI (`.github/workflows`) runs lint, typecheck, tests, build, E2E and a Docker smoke test on every push. Tags `v*` publish a multi-arch image to GHCR and build the desktop installers.

## Legal

DraxMax is a general-purpose BitTorrent client. Only download and share content you have the right to.
