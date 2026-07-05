import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { PostgresStore } from '@mastra/pg';
import { Observability, CloudExporter, SensitiveDataFilter } from '@mastra/observability';
import { mageHandAgent } from './agents/mage-hand-agent';
import { workspace } from './workspace';
import { ChatGPTCodexGateway } from './providers/chatgpt-codex-gateway';
import { getMastraPostgresConfig } from './storage-config';

export const mastra = new Mastra({
  workspace,
  agents: { mageHandAgent },
  gateways: {
    chatgpt: new ChatGPTCodexGateway(),
  },
  storage: new PostgresStore({
    id: 'mastra-storage',
    ...getMastraPostgresConfig(),
    disableInit: true,
  }),
  logger: new PinoLogger({
    name: 'WeaveAgent',
    level: 'info',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'weave-agent',
        exporters: [
          new CloudExporter(),
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(),
        ],
      },
    },
  }),
});
