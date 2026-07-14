# syntax=docker/dockerfile:1

FROM node:24-slim AS dependencies

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /workspace

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY scripts/ensure-pnpm.mjs ./scripts/ensure-pnpm.mjs
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json
COPY mobile/package.json ./mobile/package.json
COPY desktop/package.json ./desktop/package.json
COPY packages/client/package.json ./packages/client/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter weave-server...

COPY server ./server
COPY packages/protocol ./packages/protocol

RUN pnpm --filter weave-server --prod deploy /prod/server

FROM denoland/deno:2.8.3 AS runner

ENV NODE_ENV=production
ENV PORT=4111

WORKDIR /app/server

COPY --from=dependencies /prod/server ./
COPY packages/protocol /app/packages/protocol

# Deno intentionally does not strip TypeScript types from packages below
# node_modules. Keep the source-only workspace package outside node_modules,
# matching the development layout, and point the production dependency at it.
RUN rm -rf node_modules/@weave/protocol \
    && rm -rf /app/packages/protocol/node_modules \
    && ln -s ../../../packages/protocol node_modules/@weave/protocol \
    && ln -s ../../server/node_modules /app/packages/protocol/node_modules

RUN deno cache --frozen --config deno.json --node-modules-dir=manual --sloppy-imports src/server.ts

EXPOSE 4111

CMD ["deno", "task", "--config", "deno.json", "start"]
