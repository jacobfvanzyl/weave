import { CHATGPT_CODEX_GPT_5_6_MODELS } from '../../model-capabilities.ts';
import { ChatGPTCodexGateway } from './chatgpt-codex-gateway.ts';

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(message ?? `Expected ${actualJson} to equal ${expectedJson}`);
  }
};

Deno.test('ChatGPT Codex gateway registers and resolves GPT-5.6 models', async () => {
  const gateway = new ChatGPTCodexGateway();
  const providers = await gateway.fetchProviders();
  const expectedSlugs = CHATGPT_CODEX_GPT_5_6_MODELS.map(({ slug }) => slug);

  assertEquals(providers.codex.models.slice(0, expectedSlugs.length), expectedSlugs);

  for (const slug of expectedSlugs) {
    const model = gateway.resolveLanguageModel({
      modelId: `chatgpt/codex/${slug}`,
      providerId: 'codex',
      apiKey: 'chatgpt-subscription',
    });
    assertEquals(model.modelId, slug);
  }
});
