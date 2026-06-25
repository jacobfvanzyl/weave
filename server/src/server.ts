import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { loadOwnerAuthConfig, createOwnerAuthMiddleware } from './owner/auth';
import { agentCore, mastra } from './agent';
import { portalCore } from './portal';
import { registerServerModules } from './modules/types';
import { serverModules } from './modules';
import { registerCompatibilityRoutes } from './server/compatibility-routes';
import type { ServerVariables } from './server/types';

const port = Number(process.env.PORT ?? process.env.WEAVE_SERVER_PORT ?? 4111);
const auth = loadOwnerAuthConfig();
const configuredCorsOrigins = new Set(
  (process.env.WEAVE_CORS_ORIGINS ?? '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean),
);

const isLoopbackOrigin = (origin: string) => {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
};

const app = new Hono<{ Variables: ServerVariables }>();

app.use('*', cors({
  origin: origin => configuredCorsOrigins.has(origin) || isLoopbackOrigin(origin) ? origin : undefined,
  allowHeaders: ['Authorization', 'Content-Type'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));
app.get('/health', c => c.json({ ok: true }));
app.use('*', createOwnerAuthMiddleware({ auth, mastra }));

agentCore.registerRoutes(app);
portalCore.registerRoutes(app, { mastra });
registerServerModules(app, { auth, agent: agentCore, portal: portalCore }, serverModules);
registerCompatibilityRoutes(app);

Deno.serve({ port }, app.fetch);

console.info(`Weave server running at http://localhost:${port}`);
