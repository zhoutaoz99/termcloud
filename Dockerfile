FROM node:24-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm_config_build_from_source=true npm ci --no-audit --no-fund \
    && npm cache clean --force \
    && rm -rf node_modules/node-pty/prebuilds \
              node_modules/node-pty/src \
              node_modules/node-pty/deps \
              node_modules/node-pty/third_party \
    && find node_modules/node-pty/lib -name "*.map" -delete \
    && find node_modules/node-pty/lib -name "*.test.js" -delete \
    && find node_modules/node-pty/lib -name "*.test.js.map" -delete

FROM deps AS build

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build \
    && npm prune --omit=dev

FROM node:24-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV TERMCLOUD_REPLAY_BUFFER_BYTES=262144
ENV TERMCLOUD_REPLAY_FRAME_BYTES=65536
ENV TERMCLOUD_WS_BACKPRESSURE_LIMIT_BYTES=1048576
ENV TERMCLOUD_WS_COMPRESSION_THRESHOLD_BYTES=2048
ENV TERMCLOUD_SESSION_IDLE_TIMEOUT_MS=180000

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY public/ ./public/
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

RUN mkdir -p /data/users

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "--max-old-space-size=128", "dist/server.js"]
