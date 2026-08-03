# syntax=docker/dockerfile:1

FROM oven/bun:1.3.14 AS dependencies

WORKDIR /workspace

COPY package.json bun.lock bunfig.toml ./
COPY scripts/ensure-bun.mjs ./scripts/ensure-bun.mjs
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json
COPY mobile/package.json ./mobile/package.json
COPY desktop/package.json ./desktop/package.json
COPY packages/client/package.json ./packages/client/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json

RUN --mount=type=cache,id=bun-cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production --filter weave-server

COPY server ./server
COPY packages/protocol ./packages/protocol

FROM denoland/deno:2.8.3 AS runner

ENV NODE_ENV=production
ENV PORT=4111

WORKDIR /app

# Preserve the workspace root and package manifests. Deno uses that workspace
# context when validating the server lockfile against package.json dependencies.
COPY --from=dependencies /workspace ./

WORKDIR /app/server

RUN deno cache --frozen --config deno.json --node-modules-dir=manual --sloppy-imports src/server.ts

EXPOSE 4111

CMD ["deno", "task", "--config", "deno.json", "start"]
