import {
  CHATGPT_CODEX_GPT_5_6_MODELS,
  getOpenAIModelCapabilities,
  normalizeOpenAIReasoningEffort,
  normalizeOpenAIServiceTier,
} from './model-capabilities.ts';

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

Deno.test('OpenAI reasoning normalization keeps xhigh for current Codex models', () => {
  assertEquals(normalizeOpenAIReasoningEffort('xhigh', 'openai/gpt-5.5', { fallbackToDefault: true }), 'xhigh');
});

for (const { slug } of CHATGPT_CODEX_GPT_5_6_MODELS) {
  Deno.test(`${slug} exposes subscription-native capabilities`, () => {
    const capabilities = getOpenAIModelCapabilities(`openai/${slug}`);
    assertEquals(capabilities.contextWindow, 372_000);
    assertEquals(capabilities.defaultReasoningEffort, 'medium');
    assertEquals(
      capabilities.supportedReasoningEfforts.map((option) => option.effort).join(','),
      'low,medium,high,xhigh,max',
    );
    assertEquals(capabilities.serviceTiers.map((tier) => tier.id).join(','), 'priority');
    assertEquals(normalizeOpenAIReasoningEffort('max', `chatgpt/codex/${slug}`), 'max');
    assertEquals(normalizeOpenAIServiceTier('fast', `openai/${slug}`), 'priority');
  });
}

Deno.test('OpenAI reasoning normalization maps legacy fast/no-reasoning values to fastest supported effort', () => {
  assertEquals(normalizeOpenAIReasoningEffort('minimal', 'chatgpt/codex/gpt-5.5', { fallbackToDefault: true }), 'low');
  assertEquals(normalizeOpenAIReasoningEffort('off', 'openai/gpt-5.4', { fallbackToDefault: true }), 'low');
});

Deno.test('OpenAI reasoning normalization falls back to model default for invalid values', () => {
  assertEquals(normalizeOpenAIReasoningEffort('deepest', 'openai/gpt-5.5', { fallbackToDefault: true }), 'medium');
});

Deno.test('OpenAI service tier normalization maps legacy fast to priority', () => {
  assertEquals(normalizeOpenAIServiceTier('fast', 'openai/gpt-5.5'), 'priority');
  assertEquals(normalizeOpenAIServiceTier('priority', 'openai/gpt-5.5'), 'priority');
  assertEquals(normalizeOpenAIServiceTier('priority', 'openai/gpt-5.4-mini'), undefined);
});
