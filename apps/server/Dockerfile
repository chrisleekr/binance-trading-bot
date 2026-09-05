# syntax=docker/dockerfile:1.27
# Single image for the whole app. ROLE (api|worker|study|all) selects behaviour
# at runtime via the apps/server entrypoint — one build, one image, replacing the
# former per-app api/worker/web images. Ships:
#   - the bundled server entry (/app/dist/index.js) + migration runner
#     (/app/dist/migrate.js),
#   - the built SPA (/app/web), served same-origin by the api role,
#   - postgresql17-client for the in-app backup/restore (api) and db-backup
#     cron (worker) pg_dump/pg_restore.
#
# The container entrypoint runs migrations first (unless SKIP_MIGRATIONS=1), then
# exec's the entry; ROLE decides which listeners/consumers boot.

ARG BUN_VERSION=1.4.0
# `BUN_IMAGE` is split out so CI can point at a registry mirror to dodge Docker
# Hub's unauthenticated pull rate limit (#122). Defaults to the upstream image so
# local `docker build` keeps working without any extra args.
ARG BUN_IMAGE=oven/bun

FROM ${BUN_IMAGE}:${BUN_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json bun.lock turbo.json tsconfig.base.json tsconfig.json ./
COPY apps apps
COPY packages packages
COPY e2e e2e
COPY scripts scripts
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
  bun install --frozen-lockfile --ignore-scripts

FROM deps AS build
WORKDIR /app
# tsc typecheck/emit for the composed entry (its api/worker/core project refs
# build too), then bundle the runtime entry + the migration CLI, and build the
# SPA the api role serves.
RUN bun run --filter '@app/server' build \
  && bun build apps/server/src/index.ts \
  --target=bun \
  --minify \
  --outfile /app/dist/index.js \
  && bun build packages/db/src/migrate-cli.ts \
  --target=bun \
  --minify \
  --outfile /app/dist/migrate.js \
  && bun run --filter '@app/web' build

FROM ${BUN_IMAGE}:${BUN_VERSION}-alpine AS runtime
RUN apk add --no-cache curl ca-certificates postgresql17-client
WORKDIR /app

# Set a writable HOME for the app user so that the bun cache and other runtime
ENV HOME=/tmp

COPY --from=build --chown=1000:1000 /app/dist /app/dist
# The built SPA served by the api role (WEB_DIST_DIR below).
COPY --from=build --chown=1000:1000 /app/apps/web/dist /app/web
# Migration files read at runtime by /app/dist/migrate.js via import.meta.url.
COPY --chown=1000:1000 packages/db/migrations /app/migrations
COPY --chown=1000:1000 apps/server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER 1000:1000
# Build SHA for the operator /status surface. Injected via
# `--build-arg GIT_SHA=$(git rev-parse --short HEAD)`; empty default keeps a
# no-arg dev build working (boot falls back to local git, then 'unknown').
ARG GIT_SHA
ENV GIT_SHA=${GIT_SHA:-}
# The env-var reference tells operators the image sets this, and several
# framework defaults key off it — Better Auth derives its sign-in rate limit
# from NODE_ENV, so an image without it served `docker run` with the login
# throttle silently off. Compose still overrides it.
ENV NODE_ENV=production
# ROLE=all runs api + live worker + study in one process (single-box default).
# Override to api|worker|study to split across services from this same image.
ENV ROLE=all
# The api role serves the built SPA from here.
ENV WEB_DIST_DIR=/app/web
# 3000 public api (+ SPA); 9100 api admin (/readyz), 9101 worker admin
# (/healthz), both bound to 127.0.0.1 inside the container.
EXPOSE 3000 9100 9101
# Probe the api readiness (checks pg + redis). ROLE=all and ROLE=api run the api
# admin server; a worker/study-only service overrides this to the worker admin
# /healthz on 9101 (see docker-compose.scale.yml).
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s \
  CMD curl -fsS "http://127.0.0.1:${ADMIN_PORT:-9100}/readyz" || exit 1
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "/app/dist/index.js"]
