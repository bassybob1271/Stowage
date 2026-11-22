# syntax=docker/dockerfile:1.7
# One image serving the API and the built web app.
#   docker build -f deploy/Dockerfile -t stowage .

ARG NODE_IMAGE=node:22-alpine

# ---------- deps + build ----------
FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
RUN corepack enable
# Manifests first for layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/storage/package.json packages/storage/
COPY e2e/package.json e2e/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter '!@stowage/e2e'
COPY packages packages
COPY apps apps
RUN pnpm -r --filter '!@stowage/e2e' build

# ---------- production node_modules ----------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /src
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/storage/package.json packages/storage/
COPY e2e/package.json e2e/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @stowage/server...

# ---------- runtime ----------
FROM ${NODE_IMAGE}
# ffmpeg: video thumbnails; poppler-utils: PDF page-1 thumbnails; tini: PID 1.
RUN apk add --no-cache ffmpeg poppler-utils tini
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    DATABASE_URL=file:/data/stowage.db \
    MOUNTS_FILE=/config/mounts.yaml \
    WEB_DIST=/app/apps/web/dist
COPY --from=prod-deps /src/node_modules ./node_modules
COPY --from=prod-deps /src/apps/server/node_modules ./apps/server/node_modules
COPY --from=prod-deps /src/packages/storage/node_modules ./packages/storage/node_modules
COPY --from=prod-deps /src/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /src/package.json ./
COPY --from=build /src/packages/shared/package.json ./packages/shared/
COPY --from=build /src/packages/shared/dist ./packages/shared/dist
COPY --from=build /src/packages/storage/package.json ./packages/storage/
COPY --from=build /src/packages/storage/dist ./packages/storage/dist
COPY --from=build /src/apps/server/package.json ./apps/server/
COPY --from=build /src/apps/server/dist ./apps/server/dist
COPY --from=build /src/apps/web/dist ./apps/web/dist
RUN mkdir -p /data /config && chown -R node:node /data /config
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/server/dist/main.js"]
