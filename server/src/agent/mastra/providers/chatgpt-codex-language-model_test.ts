import {
  CHATGPT_CODEX_BASE_URL,
  createChatGPTCodexFetch,
  createChatGPTCodexLanguageModel,
  WEAVE_CREDENTIAL_OWNER_HEADER,
} from './chatgpt-codex-language-model.ts';

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

const userPrompt = [
  {
    role: 'user',
    content: [{ type: 'text', text: 'hello' }],
  },
];

type CapturedRequest = {
  url: string;
  headers: Headers;
  body?: Record<string, unknown>;
};

const requestUrl = (input: RequestInfo | URL) => input instanceof Request ? input.url : input.toString();

const requestBody = (body: BodyInit | null | undefined): Record<string, unknown> | undefined =>
  typeof body === 'string' ? JSON.parse(body) as Record<string, unknown> : undefined;

const jsonResponse = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const sseResponse = (events: Array<Record<string, unknown>>) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

const openAIResponse = (usage: Record<string, unknown>) => ({
  id: 'resp_test',
  created_at: 1,
  model: 'gpt-5.4',
  output: [],
  usage,
});

const usage = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 25 },
  output_tokens: 8,
  output_tokens_details: { reasoning_tokens: 3 },
};

Deno.test('createChatGPTCodexFetch injects fresh subscription headers', async () => {
  let captured: CapturedRequest | undefined;
  let credentialOwner = '';
  const codexFetch = createChatGPTCodexFetch({
    getCredentials: async ownerId => {
      credentialOwner = ownerId;
      return { access: 'fresh-token', accountId: 'account-1' };
    },
    fetch: async (input, init) => {
      captured = {
        url: requestUrl(input),
        headers: new Headers(init?.headers),
        body: requestBody(init?.body),
      };
      return jsonResponse({});
    },
  });

  await codexFetch('https://example.com/responses', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer stale-token',
      originator: 'mage-hand',
      'User-Agent': 'mage-hand',
      'OpenAI-Beta': 'stale',
      [WEAVE_CREDENTIAL_OWNER_HEADER]: encodeURIComponent('owner/one'),
    },
    body: JSON.stringify({ model: 'gpt-5.6-luna' }),
  });

  assert(captured, 'expected fetch call to be captured');
  const request = captured;
  assertEquals(request.url, 'https://example.com/responses');
  assertEquals(request.headers.get('Authorization'), 'Bearer fresh-token');
  assertEquals(request.headers.get('ChatGPT-Account-Id'), 'account-1');
  assertEquals(request.headers.get('originator'), 'codex_cli_rs');
  assertEquals(request.headers.get('User-Agent'), 'codex_cli_rs');
  assertEquals(request.headers.get('OpenAI-Beta'), 'responses=experimental');
  assertEquals(request.headers.get(WEAVE_CREDENTIAL_OWNER_HEADER), null);
  assertEquals(credentialOwner, 'owner/one');
});

Deno.test('createChatGPTCodexFetch resolves concurrent owners without leaking the private header upstream', async () => {
  const captured: Array<{ owner: string; authorization: string | null; privateHeader: string | null }> = [];
  const codexFetch = createChatGPTCodexFetch({
    getCredentials: async ownerId => ({ access: `token-${ownerId}`, accountId: `account-${ownerId}` }),
    fetch: async (_input, init) => {
      const headers = new Headers(init?.headers);
      captured.push({
        owner: headers.get('ChatGPT-Account-Id') ?? '',
        authorization: headers.get('Authorization'),
        privateHeader: headers.get(WEAVE_CREDENTIAL_OWNER_HEADER),
      });
      return jsonResponse({});
    },
  });

  await Promise.all(['owner-a', 'owner-b'].map(ownerId => codexFetch('https://example.com/responses', {
    headers: { [WEAVE_CREDENTIAL_OWNER_HEADER]: encodeURIComponent(ownerId) },
  })));

  const authorizations = captured.map(item => item.authorization).sort();
  assertEquals(authorizations[0], 'Bearer token-owner-a');
  assertEquals(authorizations[1], 'Bearer token-owner-b');
  assert(captured.every(item => item.privateHeader === null), 'private owner header must be stripped');
});

Deno.test('createChatGPTCodexFetch inlines Weave-local image attachments only', async () => {
  let captured: CapturedRequest | undefined;
  const codexFetch = createChatGPTCodexFetch({
    getCredentials: async () => ({ access: 'fresh-token', accountId: 'account-1' }),
    attachments: {
      get: async (id) =>
        id === 'att_test'
          ? {
            bytes: new Uint8Array([1, 2, 3]),
            mimeType: 'image/png',
            sizeBytes: 3,
            originalName: 'image.png',
          }
          : null,
    },
    fetch: async (input, init) => {
      captured = {
        url: requestUrl(input),
        headers: new Headers(init?.headers),
        body: requestBody(init?.body),
      };
      return jsonResponse({});
    },
  });

  await codexFetch('https://example.com/responses', {
    method: 'POST',
    body: JSON.stringify({
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_image',
              image_url: 'https://weave.local/attachments/att_test',
            },
          ],
        },
      ],
    }),
  });

  assert(captured, 'expected fetch call to be captured');
  const body = captured.body;
  assert(body, 'expected request body to be captured');
  const input = body.input as Array<Record<string, unknown>>;
  const content = input[0].content as Array<Record<string, unknown>>;
  assertEquals(content[0].image_url, 'data:image/png;base64,AQID');
});

Deno.test('GPT-5.6 max reasoning and Fast tier pass through with subscription-required store false', async () => {
  const requests: CapturedRequest[] = [];
  const model = createChatGPTCodexLanguageModel({
    modelId: 'gpt-5.6-sol',
    getCredentials: async () => ({ access: 'fresh-token', accountId: 'account-1' }),
    fetch: async (input, init) => {
      requests.push({
        url: requestUrl(input),
        headers: new Headers(init?.headers),
        body: requestBody(init?.body),
      });
      return jsonResponse(openAIResponse(usage));
    },
  });

  await model.doGenerate({
    prompt: userPrompt,
    providerOptions: {
      openai: {
        store: true,
        textVerbosity: 'high',
        parallelToolCalls: false,
        reasoningEffort: 'max',
        serviceTier: 'priority',
      },
    },
  } as any);

  assertEquals(requests.length, 1);
  const request = requests[0];
  assert(request, 'expected first request to be captured');
  const body = request.body;
  assert(body, 'expected request body to be captured');
  assertEquals(request.url, `${CHATGPT_CODEX_BASE_URL}/responses`);
  assertEquals(body.store, false);
  assertEquals((body.text as Record<string, unknown> | undefined)?.verbosity, 'high');
  assertEquals(body.parallel_tool_calls, false);
  assertEquals(body.model, 'gpt-5.6-sol');
  assertEquals((body.reasoning as Record<string, unknown> | undefined)?.effort, 'max');
  assertEquals(body.service_tier, 'priority');
});

Deno.test('only subscription-required store false is added to official defaults', async () => {
  const requests: CapturedRequest[] = [];
  const model = createChatGPTCodexLanguageModel({
    modelId: 'gpt-5.4',
    getCredentials: async () => ({ access: 'fresh-token', accountId: 'account-1' }),
    fetch: async (input, init) => {
      requests.push({
        url: requestUrl(input),
        headers: new Headers(init?.headers),
        body: requestBody(init?.body),
      });
      return jsonResponse(openAIResponse(usage));
    },
  });

  await model.doGenerate({ prompt: userPrompt } as any);

  const request = requests[0];
  assert(request, 'expected first request to be captured');
  const body = request.body;
  assert(body, 'expected request body to be captured');
  assertEquals(body.store, false);
  assert(!('text' in body), 'text verbosity should not be forced locally');
  assert(!('parallel_tool_calls' in body), 'parallel tool calls should not be forced locally');
  assert(!('reasoning' in body), 'reasoning options should not be forced locally');
  assertEquals((body.include as string[] | undefined)?.includes('reasoning.encrypted_content'), true);
});

Deno.test('legacy tool result output is normalized before the official adapter', async () => {
  const requests: CapturedRequest[] = [];
  const model = createChatGPTCodexLanguageModel({
    modelId: 'gpt-5.4',
    getCredentials: async () => ({ access: 'fresh-token', accountId: 'account-1' }),
    fetch: async (input, init) => {
      requests.push({
        url: requestUrl(input),
        headers: new Headers(init?.headers),
        body: requestBody(init?.body),
      });
      return jsonResponse(openAIResponse(usage));
    },
  });

  await model.doGenerate({
    prompt: [
      ...userPrompt,
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_rename',
            toolName: 'renameThreadTool',
            input: { title: 'General Chat' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_rename',
            toolName: 'renameThreadTool',
            output: { title: 'General Chat', renamed: true },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_empty',
            toolName: 'renameThreadTool',
            input: { title: 'General Chat' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_empty',
            toolName: 'renameThreadTool',
          },
        ],
      },
    ],
  } as any);

  const request = requests[0];
  assert(request, 'expected first request to be captured');
  const body = request.body;
  assert(body, 'expected request body to be captured');
  const input = body.input as Array<Record<string, unknown>>;
  const outputs = input.filter((part) => part.type === 'function_call_output');
  assertEquals(outputs.length, 2);
  assertEquals(outputs[0].call_id, 'call_rename');
  assertEquals(outputs[0].output, '{"title":"General Chat","renamed":true}');
  assertEquals(outputs[1].call_id, 'call_empty');
  assertEquals(outputs[1].output, '');
});

Deno.test('generate usage is bridged to Weave context usage', async () => {
  const usageSnapshots: Array<Record<string, unknown>> = [];
  let credentialOwner = '';
  const model = createChatGPTCodexLanguageModel({
    modelId: 'gpt-5.4',
    getCredentials: async ownerId => {
      credentialOwner = ownerId;
      return { access: 'fresh-token', accountId: 'account-1' };
    },
    recordUsage: (snapshot) => usageSnapshots.push(snapshot),
    fetch: async () => jsonResponse(openAIResponse(usage)),
  });

  await model.doGenerate({
    prompt: userPrompt,
    headers: { [WEAVE_CREDENTIAL_OWNER_HEADER]: encodeURIComponent('resource-1') },
    providerOptions: {
      mastraContextUsage: {
        threadId: 'thread-generate',
        resourceId: 'resource-1',
        maxTokens: 2000,
      },
    },
  } as any);

  assertEquals(usageSnapshots.length, 1);
  assertEquals(usageSnapshots[0].threadId, 'thread-generate');
  assertEquals(usageSnapshots[0].resourceId, 'resource-1');
  assertEquals(usageSnapshots[0].usedTokens, 100);
  assertEquals(usageSnapshots[0].inputTokens, 100);
  assertEquals(usageSnapshots[0].cachedInputTokens, 25);
  assertEquals(usageSnapshots[0].outputTokens, 8);
  assertEquals(usageSnapshots[0].totalProcessedTokens, 108);
  assertEquals(usageSnapshots[0].maxTokens, 2000);
  assertEquals(credentialOwner, 'resource-1');
});

Deno.test('stream finish usage is bridged to Weave context usage', async () => {
  const usageSnapshots: Array<Record<string, unknown>> = [];
  const model = createChatGPTCodexLanguageModel({
    modelId: 'gpt-5.4',
    getCredentials: async () => ({ access: 'fresh-token', accountId: 'account-1' }),
    recordUsage: (snapshot) => usageSnapshots.push(snapshot),
    fetch: async () =>
      sseResponse([
        {
          type: 'response.created',
          response: {
            id: 'resp_stream',
            created_at: 1,
            model: 'gpt-5.4',
            service_tier: null,
          },
        },
        {
          type: 'response.completed',
          response: {
            incomplete_details: null,
            usage,
            service_tier: null,
          },
        },
      ]),
  });

  const result = await model.doStream({
    prompt: userPrompt,
    providerOptions: {
      mastraContextUsage: {
        threadId: 'thread-stream',
      },
    },
  } as any);

  const reader = result.stream.getReader();
  while (!(await reader.read()).done) {
    // Drain the official stream so the finish chunk reaches the usage bridge.
  }

  assertEquals(usageSnapshots.length, 1);
  assertEquals(usageSnapshots[0].threadId, 'thread-stream');
  assertEquals(usageSnapshots[0].usedTokens, 100);
  assertEquals(usageSnapshots[0].outputTokens, 8);
});
