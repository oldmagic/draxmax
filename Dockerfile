# syntax=docker/dockerfile:1.7

# ---- Build: install, build Web UI + server bundle, prune to production deps ----
# Base images are pinned by digest so a rebuild can't silently pick up a different image;
# Dependabot proposes the updates (.github/dependabot.yml).
FROM node:24-bookworm@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496 AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /src

# Manifests first so the dependency layer is cached across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@draxmax/server..." --filter "@draxmax/web..."

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/web ./apps/web
RUN pnpm --filter @draxmax/web build && pnpm --filter @draxmax/server build

# Self-contained production tree: package + pruned node_modules (native modules already compiled).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @draxmax/server deploy --prod --legacy /out \
 && rm -rf /out/src /out/build.mjs /out/tsconfig.json \
 && cp -r apps/server/dist /out/dist \
 && cp -r apps/web/dist /out/web

# ---- Runtime ----
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
# Pick up Debian security fixes released since the base image was built.
RUN apt-get update \
 && apt-get -y upgrade --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8895 \
    CONFIG_PATH=/config \
    DOWNLOAD_PATH=/downloads \
    WEB_ROOT=/app/web \
    WATCH_PATH=/watch \
    TORRENT_PORT=6881
# glibc otherwise keeps up to 8 malloc arenas per core; fragmentation across them left
# ~450 MB resident for a ~40 MB JS heap.
ENV MALLOC_ARENA_MAX=2
WORKDIR /app
COPY --from=build /out /app
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN mkdir -p /config /downloads /watch && chown node:node /config /downloads /watch

# Starts as root to apply PUID/PGID and volume ownership, then drops to `node`.
ENV PUID=1000 PGID=1000 DRAXMAX_DOCKER=1
EXPOSE 8895 6881/tcp 6881/udp 6882/udp
VOLUME ["/config", "/downloads", "/watch"]
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const h=process.env.HOST;fetch('http://'+(!h||h==='0.0.0.0'||h==='::'?'127.0.0.1':h.includes(':')?'['+h+']':h)+':'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "--enable-source-maps", "dist/server.js"]
