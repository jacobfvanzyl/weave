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
import { internalServices } from './services';
import { maybeLaunchDbosWorkflowRuntime } from './workflows';
import { requireWeaveDatabaseUrl } from './storage/database-url';
import { getContextBudgetPercentages } from './agent/context-budget';
import { assertCredentialEncryptionConfigured } from './agent/credentials/chatgpt-credential-repository';
import { isAllowedCorsOrigin } from './server/cors-origin';
import { agentRunRepository } from './agent/run-repository';

requireWeaveDatabaseUrl();
getContextBudgetPercentages();
assertCredentialEncryptionConfigured();
await agentRunRepository.interruptActiveRuns();

const port = Number(process.env.PORT ?? process.env.WEAVE_SERVER_PORT ?? 4111);
const auth = loadOwnerAuthConfig();
const configuredCorsOrigins = new Set(
  (process.env.WEAVE_CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);

const app = new Hono<{ Variables: ServerVariables }>();

app.use(
  '*',
  cors({
    origin: (origin) => isAllowedCorsOrigin(origin, configuredCorsOrigins) ? origin : undefined,
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }),
);
app.get('/health', (c) => c.json({ ok: true }));
app.use('*', createOwnerAuthMiddleware({ auth, mastra }));

agentCore.registerRoutes(app);
portalCore.registerRoutes(app, { mastra, sessions: internalServices.sessions });
registerServerModules(app, { auth, agent: agentCore, portal: portalCore, internal: internalServices }, serverModules);
registerCompatibilityRoutes(app, {
  agent: agentCore.service,
  resources: internalServices.resources,
  sessions: internalServices.sessions,
});

startServerPerfSampler({
  sample: () => ({ chat: agentCore.service.getChatPerfSnapshot() }),
});

await maybeLaunchDbosWorkflowRuntime();

Deno.serve({ port }, app.fetch);

console.info(`Weave server running at http://localhost:${port}`);
