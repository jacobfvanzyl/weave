import { __modelOptionsTest, getModelConfig, resolveModelOption } from './model-options.ts';

const withModelEnv = async (env: Record<string, string>, run: () => Promise<void>) => {
  const names = ['WEAVE_DEFAULT_MODEL', 'WEAVE_MODEL_OPTIONS'];
  const previous = Object.fromEntries(names.map((name) => [name, Deno.env.get(name)]));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
  try {
    for (const name of names) Deno.env.delete(name);
    for (const [name, value] of Object.entries(env)) Deno.env.set(name, value);
    __modelOptionsTest.clearCache();
    await run();
  } finally {
    globalThis.fetch = previousFetch;
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    __modelOptionsTest.clearCache();
  }
};

Deno.test('WEAVE_MODEL_OPTIONS contextWindow explicitly overrides built-in advertising', async () => {
  await withModelEnv({
    WEAVE_DEFAULT_MODEL: 'openai/gpt-5.6-luna',
    WEAVE_MODEL_OPTIONS: JSON.stringify([{ id: 'openai/gpt-5.6-luna', contextWindow: 400_000 }]),
  }, async () => {
    const config = await getModelConfig();
    if (config.options[0]?.contextWindow !== 400_000) throw new Error('expected configured context override');
  });
});

Deno.test('an empty WEAVE_DEFAULT_MODEL falls back to the default subscription model', async () => {
  await withModelEnv({ WEAVE_DEFAULT_MODEL: '' }, async () => {
    const config = await getModelConfig();
    if (config.defaultModel !== 'openai/gpt-5.6-sol') {
      throw new Error(`expected Sol fallback, got ${config.defaultModel}`);
    }
  });
});

Deno.test('a selected model without advertised context is rejected', async () => {
  await withModelEnv({
    WEAVE_DEFAULT_MODEL: 'custom/unadvertised',
    WEAVE_MODEL_OPTIONS: JSON.stringify(['custom/unadvertised']),
  }, async () => {
    try {
      await resolveModelOption('custom/unadvertised');
    } catch (error) {
      if (String(error).includes('does not advertise')) return;
      throw error;
    }
    throw new Error('expected missing context advertisement to be rejected');
  });
});
