# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4111
ENV WEAVE_PORTAL_WS_PORT=4112

COPY --from=builder /app/.mastra/output ./
RUN mkdir -p /app/.data

EXPOSE 4111 4112
VOLUME ["/app/.data"]

CMD ["node", "index.mjs"]
