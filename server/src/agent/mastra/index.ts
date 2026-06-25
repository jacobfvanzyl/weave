import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { Observability, CloudExporter, SensitiveDataFilter } from '@mastra/observability';
import { mageHandAgent } from './agents/mage-hand-agent';
import { workspace } from './workspace';
import { ChatGPTCodexGateway } from './providers/chatgpt-codex-gateway';
import { storageAuthToken, storageUrl } from './storage-config';

export const mastra = new Mastra({
  workspace,
  agents: { mageHandAgent },
  gateways: {
    chatgpt: new ChatGPTCodexGateway(),
  },
  storage: new LibSQLStore({
    id: 'mastra-storage',
    url: storageUrl,
    authToken: storageAuthToken,
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
