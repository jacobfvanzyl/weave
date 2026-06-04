import { MastraModelGateway, type ProviderConfig, type GatewayLanguageModel } from '@mastra/core/llm';
import { getCodexCredentials } from './chatgpt-codex-auth';
import { ChatGPTCodexLanguageModel } from './chatgpt-codex-language-model';

const models = [
  'gpt-5.1-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.5',
];

export class ChatGPTCodexGateway extends MastraModelGateway {
  readonly id = 'chatgpt';
  readonly name = 'ChatGPT Subscription';

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    return {
      codex: {
        name: 'ChatGPT Codex',
        models,
        apiKeyEnvVar: 'CHATGPT_CODEX_ACCESS_TOKEN',
        gateway: this.id,
      },
    };
  }

  buildUrl(): string {
    return 'https://chatgpt.com/backend-api/codex/responses';
  }

  async getApiKey(): Promise<string> {
    return (await getCodexCredentials()).access;
  }

  resolveLanguageModel({ modelId }: { modelId: string; providerId: string; apiKey: string; headers?: Record<string, string> }): GatewayLanguageModel {
    return new ChatGPTCodexLanguageModel(modelId.split('/').at(-1) ?? modelId);
  }
}
