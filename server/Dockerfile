# syntax=docker/dockerfile:1

FROM denoland/deno:2.8.3 AS runner
WORKDIR /app/server

ENV NODE_ENV=production
ENV PORT=4111

COPY server/deno.json server/deno.lock server/package.json server/package-lock.json ./
RUN deno install --frozen --config deno.json --node-modules-dir=auto

COPY packages/protocol /app/packages/protocol
COPY server/drizzle ./drizzle
COPY server/drizzle.config.ts ./
COPY server/src ./src
RUN deno cache --frozen --config deno.json --node-modules-dir=auto --sloppy-imports src/server.ts

EXPOSE 4111

CMD ["deno", "task", "--config", "deno.json", "start"]
