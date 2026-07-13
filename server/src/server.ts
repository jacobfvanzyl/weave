import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { loadOwnerAuthConfig } from './owner/auth';
import { agentCore, mastra } from './agent';
import { portalCore } from './portal';
import { serverModules } from './modules';
import { registerServerRpcModules } from './modules/types.ts';
import type { ServerVariables } from './server/types';
import { startServerPerfSampler } from './server/perf';
import { internalServices } from './services';
import { maybeLaunchDbosWorkflowRuntime } from './workflows';
import { requireWeaveDatabaseUrl } from './storage/database-url';
import { getContextBudgetPercentages } from './agent/context-budget';
import { assertCredentialEncryptionConfigured } from './agent/credentials/chatgpt-credential-repository';
import { isAllowedCorsOrigin } from './server/cors-origin';
import { agentRunRepository } from './agent/run-repository';
import {
  createInternalModuleApi,
  createRpcUpgradeHandler,
  registerCoreRpcMethods,
  rpcGatewayStats,
  RpcRouter,
} from './rpc/index.ts';

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
const rpcRouter = new RpcRouter();
const requestModule = createInternalModuleApi({
  auth,
  mastra,
  agent: agentCore,
  portal: portalCore,
  internal: internalServices,
  modules: serverModules,
});
registerCoreRpcMethods(rpcRouter, {
  agent: agentCore,
  portal: portalCore,
  internal: internalServices,
});
registerServerRpcModules(rpcRouter, {
  auth,
  agent: agentCore,
  portal: portalCore,
  internal: internalServices,
  requestModule,
}, serverModules);

app.use(
  '*',
  cors({
    origin: (origin) => isAllowedCorsOrigin(origin, configuredCorsOrigins) ? origin : undefined,
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }),
);
app.get('/health', (c) => c.json({ ok: true, rpc: rpcGatewayStats() }));
app.get('/rpc', createRpcUpgradeHandler({ auth, router: rpcRouter, configuredOrigins: configuredCorsOrigins }));
app.notFound((c) => c.json({ error: 'Not found' }, 404));

startServerPerfSampler({
  sample: () => ({ chat: agentCore.service.getChatPerfSnapshot() }),
});

await maybeLaunchDbosWorkflowRuntime();

Deno.serve({ port }, app.fetch);

console.info(`Weave server running at http://localhost:${port}`);
