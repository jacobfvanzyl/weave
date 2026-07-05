import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createOwnerAuthMiddleware, loadOwnerAuthConfig } from './owner/auth';
import { agentCore, mastra } from './agent';
import { portalCore } from './portal';
import { registerServerModules } from './modules/types';
import { serverModules } from './modules';
import { registerCompatibilityRoutes } from './server/compatibility-routes';
import type { ServerVariables } from './server/types';
import { startServerPerfSampler } from './server/perf';
import { getChatPerfSnapshot } from './modules/chat/routes/chat';
import { internalServices } from './services';

const port = Number(process.env.PORT ?? process.env.WEAVE_SERVER_PORT ?? 4111);
const auth = loadOwnerAuthConfig();
const configuredCorsOrigins = new Set(
  (process.env.WEAVE_CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);

const isLoopbackOrigin = (origin: string) => {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
};

const isPrivateIpv4Host = (host: string) => {
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;

  const [first, second] = parts;
  return first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254);
};

const isLocalNetworkOrigin = (origin: string) => {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      (isPrivateIpv4Host(url.hostname) || url.hostname.endsWith('.local'));
  } catch {
    return false;
  }
};

const app = new Hono<{ Variables: ServerVariables }>();

app.use(
  '*',
  cors({
    origin: (origin) =>
      configuredCorsOrigins.has(origin) || isLoopbackOrigin(origin) || isLocalNetworkOrigin(origin)
        ? origin
        : undefined,
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }),
);
app.get('/health', (c) => c.json({ ok: true }));
app.use('*', createOwnerAuthMiddleware({ auth, mastra }));

agentCore.registerRoutes(app);
portalCore.registerRoutes(app, { mastra, sessions: internalServices.sessions });
registerServerModules(app, { auth, agent: agentCore, portal: portalCore, internal: internalServices }, serverModules);
registerCompatibilityRoutes(app, { sessions: internalServices.sessions });

startServerPerfSampler({
  sample: () => ({ chat: getChatPerfSnapshot() }),
});

Deno.serve({ port }, app.fetch);

console.info(`Weave server running at http://localhost:${port}`);
