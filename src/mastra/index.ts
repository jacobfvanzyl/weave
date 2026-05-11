
import { Mastra } from '@mastra/core/mastra';
import { SimpleAuth } from '@mastra/core/server';
import { PinoLogger } from '@mastra/loggers';
import { MastraEditor } from '@mastra/editor';
import { chatRoute } from '@mastra/ai-sdk';
import { LibSQLStore } from '@mastra/libsql';
import { DuckDBStore } from "@mastra/duckdb";
import { MastraCompositeStore } from '@mastra/core/storage';
import { Observability, DefaultExporter, CloudExporter, SensitiveDataFilter } from '@mastra/observability';
import { weatherWorkflow } from './workflows/weather-workflow';
import { mageHandAgent } from './agents/mage-hand-agent';
import { toolCallAppropriatenessScorer, completenessScorer, translationScorer } from './scorers/weather-scorer';
import { chatStateRoutes } from './routes/chat-state';

type SimpleAuthUser = {
  id: string;
  name: string;
  role: 'user';
};

const parseAuthTokens = () => {
  if (process.env.WEAVE_AUTH_TOKENS) {
    return JSON.parse(process.env.WEAVE_AUTH_TOKENS) as Record<string, SimpleAuthUser>;
  }

  const authToken = process.env.WEAVE_AUTH_TOKEN;
  if (!authToken) {
    throw new Error('WEAVE_AUTH_TOKEN or WEAVE_AUTH_TOKENS is required when SimpleAuth is enabled');
  }

  return {
    [authToken]: {
      id: process.env.WEAVE_AUTH_USER_ID ?? 'local-user',
      name: process.env.WEAVE_AUTH_USER_NAME ?? 'Local User',
      role: 'user' as const,
    },
  };
};

const storageUrl = process.env.TURSO_DATABASE_URL ?? process.env.MASTRA_STORAGE_URL ?? 'file:./mastra.db';
const storageAuthToken = process.env.TURSO_AUTH_TOKEN ?? process.env.MASTRA_STORAGE_AUTH_TOKEN;

export const mastra = new Mastra({
  workflows: { weatherWorkflow },
  agents: { mageHandAgent },
  scorers: { toolCallAppropriatenessScorer, completenessScorer, translationScorer },
  editor: new MastraEditor(),
  server: {
    auth: new SimpleAuth<SimpleAuthUser>({
      tokens: parseAuthTokens(),
      mapUserToResourceId: user => user.id,
    }),
    apiRoutes: [
      chatRoute({
        path: '/chat',
        agent: 'mage-hand',
        version: 'v6',
      }),
      ...chatStateRoutes,
    ],
  },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new LibSQLStore({
      id: "mastra-storage",
      url: storageUrl,
      authToken: storageAuthToken,
    }),
    domains: {
      observability: await new DuckDBStore().getStore('observability'),
    }
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [
          new DefaultExporter(), // Persists traces to storage for Mastra Studio
          new CloudExporter(), // Sends observability data to hosted Mastra Studio (if MASTRA_CLOUD_ACCESS_TOKEN is set)
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
});
