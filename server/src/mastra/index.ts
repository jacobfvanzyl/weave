
import { Mastra } from '@mastra/core/mastra';
import { SimpleAuth } from '@mastra/core/server';
import { PinoLogger } from '@mastra/loggers';
import { MastraEditor } from '@mastra/editor';
import { LibSQLStore } from '@mastra/libsql';
import { DuckDBStore } from '@mastra/duckdb';
import { MastraCompositeStore } from '@mastra/core/storage';
import { Observability, DefaultExporter, CloudExporter, SensitiveDataFilter } from '@mastra/observability';
import { mageHandAgent } from './agents/mage-hand-agent';
import { workspace } from './workspace';
import { chatRoutes } from './routes/chat';
import { chatStateRoutes } from './routes/chat-state';
import { promptRoutes } from './routes/prompts';
import { profileRoutes } from './routes/profiles';
import { projectRoutes } from './routes/projects';
import { portalSocketRoutes } from './routes/portal-socket';
import { terminalRoutes } from './routes/terminals';
import { editorRoutes } from './routes/editor';
import { chatgptAuthRoutes } from './routes/chatgpt-auth';
import { modelRoutes } from './routes/models';
import { attachmentRoutes } from './routes/attachments';
import { parseAuthTokens, type SimpleAuthUser } from './auth';
import { startPortalWebSocketSidecar } from './portal/websocket-sidecar';
import { ChatGPTCodexGateway } from './providers/chatgpt-codex-gateway';
import { storageAuthToken, storageUrl } from './storage-config';

const duckDBObservabilityEnv = process.env.WEAVE_ENABLE_DUCKDB_OBSERVABILITY?.toLowerCase();
const enableDuckDBObservability = duckDBObservabilityEnv === 'true'
  || (duckDBObservabilityEnv !== 'false' && process.env.MASTRA_DEV !== 'true');
const observabilityStore = enableDuckDBObservability
  ? await new DuckDBStore().getStore('observability')
  : undefined;
const observabilityExporters = enableDuckDBObservability
  ? [
      new DefaultExporter(), // Persists traces to storage for Mastra Studio
      new CloudExporter(), // Sends observability data to hosted Mastra Studio (if MASTRA_CLOUD_ACCESS_TOKEN is set)
    ]
  : [
      new CloudExporter(), // Sends observability data to hosted Mastra Studio (if MASTRA_CLOUD_ACCESS_TOKEN is set)
    ];

export const mastra = new Mastra({
  workspace,
  agents: { mageHandAgent },
  gateways: {
    chatgpt: new ChatGPTCodexGateway(),
  },
  editor: new MastraEditor(),
  server: {
    auth: new SimpleAuth<SimpleAuthUser>({
      tokens: parseAuthTokens(),
      mapUserToResourceId: user => user.id,
    }),
    apiRoutes: [
      ...chatRoutes,
      ...chatStateRoutes,
      ...promptRoutes,
      ...profileRoutes,
      ...projectRoutes,
      ...portalSocketRoutes,
      ...terminalRoutes,
      ...editorRoutes,
      ...chatgptAuthRoutes,
      ...modelRoutes,
      ...attachmentRoutes,
    ],
  },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new LibSQLStore({
      id: 'mastra-storage',
      url: storageUrl,
      authToken: storageAuthToken,
    }),
    ...(observabilityStore ? {
      domains: {
        observability: observabilityStore,
      },
    } : {}),
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: observabilityExporters,
        spanOutputProcessors: [
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
});

startPortalWebSocketSidecar(mastra as any);
