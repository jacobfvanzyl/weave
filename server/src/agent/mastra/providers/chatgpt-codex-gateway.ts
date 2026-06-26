import {
  type GatewayAuthResult,
  type GatewayLanguageModel,
  MastraModelGateway,
  type ProviderConfig,
} from '@mastra/core/llm';
import { createChatGPTCodexLanguageModel } from './chatgpt-codex-language-model';

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
    return 'https://chatgpt.com/backend-api/codex';
  }

  async getApiKey(): Promise<string> {
    return 'chatgpt-subscription';
  }

  resolveAuth(): GatewayAuthResult {
    return { apiKey: 'chatgpt-subscription', source: 'gateway' };
  }

  resolveLanguageModel({
    modelId,
    headers,
  }: {
    modelId: string;
    providerId: string;
    apiKey: string;
    headers?: Record<string, string>;
  }): GatewayLanguageModel {
    return createChatGPTCodexLanguageModel({
      modelId: modelId.split('/').at(-1) ?? modelId,
      headers,
    }) as GatewayLanguageModel;
  }
}
