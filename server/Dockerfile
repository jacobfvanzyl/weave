# syntax=docker/dockerfile:1

FROM denoland/deno:2.8.3 AS runner
WORKDIR /app/server

ENV NODE_ENV=production
ENV PORT=4111
ENV WEAVE_PORTAL_WS_PORT=4112

COPY deno.json deno.lock package.json package-lock.json ./
RUN deno install --frozen --config deno.json --node-modules-dir=auto

COPY drizzle ./drizzle
COPY drizzle.config.ts ./
COPY src ./src
RUN deno cache --frozen --config deno.json --node-modules-dir=auto --sloppy-imports src/server.ts

EXPOSE 4111 4112

CMD ["deno", "task", "--config", "deno.json", "start"]
