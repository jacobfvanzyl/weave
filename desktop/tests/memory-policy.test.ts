import { describe, expect, it } from 'vitest';
import {
  CompactToolHistoryProcessor,
  compactToolHistoryPrompt,
  createCompactToolHistoryPart,
  getToolHistoryFullCalls,
  limitCompactToolHistoryPrompt,
} from '../../server/src/mastra/compact-tool-history-processor';
import { CurrentTurnImageProcessor } from '../../server/src/mastra/current-turn-image-processor';
import { resolveMemoryPolicy } from '../../server/src/mastra/memory-policy';
import { __chatRouteMemoryTest } from '../../server/src/mastra/routes/chat';
import { __chatStateContextUsageTest } from '../../server/src/mastra/routes/chat-state';
import { getCodeToolModelOutputMaxChars } from '../../server/src/mastra/tools/model-output';
import { portalBashModelOutput, portalReadModelOutput } from '../../server/src/mastra/tools/portal-tools';

const noMemoryCapabilities = {
  semanticRecall: false,
  observationalMemory: false,
};

const semanticCapabilities = {
  semanticRecall: true,
  observationalMemory: false,
};

const modelOutputBody = (output: string) => {
  const bodyStart = output.indexOf('\n\n');
  return bodyStart === -1 ? '' : output.slice(bodyStart + 2);
};

const countImageParts = (prompt: any[]) => prompt.reduce((total, message) => {
  const parts = Array.isArray(message.content) ? message.content : [];
  return total + parts.filter((part: any) => (
    part?.type === 'image' ||
    part?.type === 'input_image' ||
    (part?.type === 'file' && typeof part.mediaType === 'string' && part.mediaType.startsWith('image/'))
  )).length;
}, 0);

describe('memory policy resolution', () => {
  it('strips semantic recall when embedding env is unavailable', () => {
    const policy = resolveMemoryPolicy({
      profileMemory: {
        lastMessages: 20,
        semanticRecall: { scope: 'workspace', topK: 8 },
      },
      threadMetadata: { projectId: 'project-1', workspaceId: 'workspace-1' },
      capabilities: noMemoryCapabilities,
    });

    expect(policy.options).toEqual({ lastMessages: 20 });
    expect(policy.status.semanticRecall).toMatchObject({
      enabled: false,
      configured: false,
      requested: true,
    });
  });

  it('builds workspace-scoped semantic recall with project and workspace filters', () => {
    const policy = resolveMemoryPolicy({
      profileMemory: {
        lastMessages: 20,
        semanticRecall: { scope: 'workspace', topK: 6, messageRange: { before: 2, after: 3 } },
      },
      threadMetadata: { projectId: 'project-1', workspaceId: 'workspace-1' },
      capabilities: semanticCapabilities,
    });

    expect(policy.options.semanticRecall).toEqual({
      scope: 'resource',
      topK: 6,
      messageRange: { before: 2, after: 3 },
      filter: {
        $and: [
          { projectId: { $eq: 'project-1' } },
          { workspaceId: { $eq: 'workspace-1' } },
        ],
      },
    });
    expect(policy.status.semanticRecall).toMatchObject({
      enabled: true,
      scope: 'resource',
      aliasScope: 'workspace',
    });
  });

  it('falls workspace semantic recall back to thread scope without workspace metadata', () => {
    const policy = resolveMemoryPolicy({
      profileMemory: { semanticRecall: true },
      threadMetadata: {},
      capabilities: semanticCapabilities,
    });

    expect(policy.options.semanticRecall).toEqual({ scope: 'thread' });
    expect(policy.status.semanticRecall).toMatchObject({
      enabled: true,
      reason: 'workspace metadata unavailable; using thread scope',
    });
  });

  it('adds observational memory only when fully configured', () => {
    const policy = resolveMemoryPolicy({
      profileMemory: { lastMessages: 10 },
      capabilities: {
        semanticRecall: false,
        observationalMemory: true,
        observationalMemoryModel: 'openai/gpt-5-mini',
      },
    });

    expect(policy.options.observationalMemory).toMatchObject({
      model: 'openai/gpt-5-mini',
      scope: 'thread',
    });
    expect(policy.status.observationalMemory).toEqual({
      enabled: true,
      configured: true,
    });
  });
});

describe('tool model output compaction', () => {
  it('resolves code tool model-output cap from defaults and env', () => {
    expect(getCodeToolModelOutputMaxChars({} as NodeJS.ProcessEnv)).toBe(12_000);
    expect(getCodeToolModelOutputMaxChars({
      WEAVE_CODE_TOOL_MODEL_OUTPUT_MAX_CHARS: '4096',
    } as NodeJS.ProcessEnv)).toBe(4096);
    expect(getCodeToolModelOutputMaxChars({ WEAVE_CODE_TOOL_MODEL_OUTPUT_MAX_CHARS: 'nope' } as NodeJS.ProcessEnv)).toBe(12_000);
  });

  it('keeps code read output up to the code-tool cap before truncating', () => {
    const rawContent = 'x'.repeat(13_000);
    const output = portalReadModelOutput({
      ok: true,
      path: 'src/example.ts',
      content: rawContent,
    });

    expect(output).toContain('path: src/example.ts');
    expect(output).toContain('contentChars: 13000');
    expect(output).toContain('truncated: true');
    expect(output).toContain('contentHash:');
    expect(output.startsWith('read\n')).toBe(true);
    expect(modelOutputBody(output)).toBe(rawContent.slice(0, 12_000));
  });

  it('keeps bash output up to the code-tool cap before truncating', () => {
    const stdout = 'b'.repeat(13_000);
    const rawBody = `stdout:\n${stdout}`;
    const output = portalBashModelOutput({
      ok: true,
      command: 'sed -n 1,260p src/example.ts',
      stdout,
      exitCode: 0,
    });

    expect(output).toContain('command: sed -n 1,260p src/example.ts');
    expect(output).toContain(`contentChars: ${rawBody.length}`);
    expect(output).toContain('truncated: true');
    expect(output).toContain('contentHash:');
    expect(modelOutputBody(output)).toBe(rawBody.slice(0, 12_000));
  });

  it('compacts old provider prompt tool results while preserving recent tool steps', () => {
    const prompt = [
      { role: 'user', content: [{ type: 'text', text: 'question' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'read', input: { path: 'old.ts' } }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'read',
            output: { type: 'text', value: 'read\npath: old.ts\ncontentHash: abc123' },
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call-2', toolName: 'bash', input: { command: 'pwd' } }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-2',
            toolName: 'bash',
            output: { type: 'text', value: 'bash\nok: true\ncommand: pwd' },
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call-3', toolName: 'bash', input: { command: 'ls' } }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-3',
            toolName: 'bash',
            output: { type: 'text', value: 'bash\nok: true\ncommand: ls' },
          },
        ],
      },
    ];

    const compacted = compactToolHistoryPrompt(prompt as any, { preserveToolSteps: 2 }) as any[];

    expect(compacted).toHaveLength(7);
    expect(compacted[1].content[0]).toMatchObject({ type: 'tool-call', toolCallId: 'call-1' });
    expect(compacted[2]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'read',
          output: {
            type: 'text',
            value: [
              'Compact tool result summary',
              'tool: read',
              'toolCallId: call-1',
              '',
              'read\npath: old.ts\ncontentHash: abc123',
            ].join('\n'),
          },
        },
      ],
    });
    expect(compacted[3].content[0]).toMatchObject({ type: 'tool-call', toolCallId: 'call-2' });
    expect(compacted[4].content[0]).toMatchObject({ type: 'tool-result', toolCallId: 'call-2' });
    expect(compacted[5].content[0]).toMatchObject({ type: 'tool-call', toolCallId: 'call-3' });
    expect(compacted[6].content[0]).toMatchObject({ type: 'tool-result', toolCallId: 'call-3' });
    expect(prompt[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'read', input: { path: 'old.ts' } }],
    });
  });

  it('resolves full tool-call retention from defaults and env', () => {
    expect(getToolHistoryFullCalls({} as NodeJS.ProcessEnv)).toBe(16);
    expect(getToolHistoryFullCalls({ WEAVE_TOOL_HISTORY_FULL_CALLS: '8' } as NodeJS.ProcessEnv)).toBe(8);
    expect(getToolHistoryFullCalls({ WEAVE_TOOL_HISTORY_FULL_CALLS: 'nope' } as NodeJS.ProcessEnv)).toBe(16);
  });

  it('preserves the latest 16 individual tool call ids, including parallel calls', () => {
    const parallelIds = [1, 2, 3];
    const laterIds = Array.from({ length: 15 }, (_, index) => index + 4);
    const prompt = [
      {
        role: 'assistant',
        content: parallelIds.map(index => ({
          type: 'tool-call',
          toolCallId: `call-${index}`,
          toolName: 'read',
          input: { path: `file-${index}.ts` },
        })),
      },
      {
        role: 'tool',
        content: parallelIds.map(index => ({
          type: 'tool-result',
          toolCallId: `call-${index}`,
          toolName: 'read',
          output: { type: 'text', value: `raw call-${index}` },
        })),
      },
      ...laterIds.flatMap(index => [
        {
          role: 'assistant',
          content: [{
            type: 'tool-call',
            toolCallId: `call-${index}`,
            toolName: 'bash',
            input: { command: `echo ${index}` },
          }],
        },
        {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: `call-${index}`,
            toolName: 'bash',
            output: { type: 'text', value: `raw call-${index}` },
          }],
        },
      ]),
    ];

    const compacted = compactToolHistoryPrompt(prompt as any, {
      preserveToolCalls: getToolHistoryFullCalls({} as NodeJS.ProcessEnv),
    }) as any[];
    const toolResultParts = compacted
      .filter(message => message.role === 'tool')
      .flatMap(message => message.content);
    const fullResultIds = toolResultParts
      .filter(part => !part.output.value.startsWith('Compact tool result summary'))
      .map(part => part.toolCallId);

    expect(toolResultParts.find(part => part.toolCallId === 'call-1')?.output.value).toContain('Compact tool result summary');
    expect(toolResultParts.find(part => part.toolCallId === 'call-2')?.output.value).toContain('Compact tool result summary');
    expect(toolResultParts.find(part => part.toolCallId === 'call-3')?.output).toEqual({ type: 'text', value: 'raw call-3' });
    expect(fullResultIds).toEqual(Array.from({ length: 16 }, (_, index) => `call-${index + 3}`));
  });

  it('keeps provider prompt tool-call and tool-output pairs when compacting', () => {
    const prompt = [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'read', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'read',
            output: { type: 'text', value: 'raw output' },
          },
        ],
      },
    ];

    const compacted = compactToolHistoryPrompt(prompt as any, { preserveToolSteps: 0 }) as any[];

    expect(compacted).toHaveLength(2);
    expect(compacted[0]).toEqual(prompt[0]);
    expect(compacted[1]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'read',
          output: {
            type: 'text',
            value: [
              'Compact tool result summary',
              'tool: read',
              'toolCallId: call-1',
              '',
              'raw output',
            ].join('\n'),
          },
        },
      ],
    });
  });

  it('does not expose message-list processor hooks that can persist compact summaries', () => {
    const processor = new CompactToolHistoryProcessor();

    expect('processInput' in processor).toBe(false);
    expect('processInputStep' in processor).toBe(false);
    expect(typeof processor.processLLMRequest).toBe('function');
  });

  it('limits provider prompts after compaction without orphaning tool results', () => {
    const prompt = [
      { role: 'system', content: 'stable instructions' },
      { role: 'user', content: [{ type: 'text', text: 'old question' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call-old', toolName: 'read', input: { path: 'old.ts' } }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-old',
            toolName: 'read',
            output: { type: 'text', value: `read\npath: old.ts\n${'x'.repeat(4_000)}` },
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call-new', toolName: 'bash', input: { command: 'pwd' } }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-new',
            toolName: 'bash',
            output: { type: 'text', value: 'bash\nok: true\ncommand: pwd' },
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'current question' }] },
    ];

    const compacted = compactToolHistoryPrompt(prompt as any, { preserveToolSteps: 1 });
    const limited = limitCompactToolHistoryPrompt(compacted as any, 180) as any[];

    expect(limited).toEqual([
      { role: 'system', content: 'stable instructions' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call-new', toolName: 'bash', input: { command: 'pwd' } }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-new',
            toolName: 'bash',
            output: { type: 'text', value: 'bash\nok: true\ncommand: pwd' },
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'current question' }] },
    ]);
    expect(limited.some(message => JSON.stringify(message).includes('call-old'))).toBe(false);
  });

  it('removes already-leaked compact summary text from outbound prompts', () => {
    const prompt = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Compact tool result summary\ntool: read\n\nread\npath: old.ts' },
          { type: 'text', text: 'Actual assistant answer.' },
        ],
      },
    ];

    const compacted = compactToolHistoryPrompt(prompt as any) as any[];

    expect(compacted).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Actual assistant answer.' }],
      },
    ]);
  });

  it('compacts older provider-executed assistant tool results', () => {
    const prompt = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'read', input: { path: 'old.ts' } },
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'read',
            output: { type: 'json', value: { ok: true, path: 'old.ts' } },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-2', toolName: 'bash', input: { command: 'pwd' } },
          {
            type: 'tool-result',
            toolCallId: 'call-2',
            toolName: 'bash',
            output: { type: 'text', value: 'bash\ncommand: pwd' },
          },
        ],
      },
    ];

    const compacted = compactToolHistoryPrompt(prompt as any, { preserveToolSteps: 1 }) as any[];

    expect(compacted[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'read', input: { path: 'old.ts' } },
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'read',
          output: {
            type: 'text',
            value: [
              'Compact tool result summary',
              'tool: read',
              'toolCallId: call-1',
              '',
              '{"ok":true,"path":"old.ts"}',
            ].join('\n'),
          },
        },
      ],
    });
    expect(compacted[1].content).toEqual(prompt[1].content);
  });

  it('rewrites compact history only at the provider prompt boundary', () => {
    const processor = new CompactToolHistoryProcessor({ preserveToolSteps: 0 });
    const prompt = [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'read', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'read',
            output: { type: 'text', value: 'read\npath: old.ts' },
          },
        ],
      },
    ];

    const result = processor.processLLMRequest({ prompt } as any) as any;

    expect(result.prompt).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'read', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'read',
            output: {
              type: 'text',
              value: [
                'Compact tool result summary',
                'tool: read',
                'toolCallId: call-1',
                '',
                'read\npath: old.ts',
              ].join('\n'),
            },
          },
        ],
      },
    ]);
    expect(prompt[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'read', input: {} }],
    });
  });

  it('does not serialize compact model-only summaries as visible UI text', () => {
    const compactPart = createCompactToolHistoryPart('read', 'read\npath: large-file.ts', 'call-1');
    const uiMessage = __chatStateContextUsageTest.toUiMessage({
      id: 'assistant-1',
      role: 'assistant',
      threadId: 'thread-1',
      resourceId: 'resource-1',
      createdAt: new Date(),
      content: {
        parts: [
          {
            type: 'tool-invocation',
            toolInvocation: {
              state: 'result',
              toolName: 'read',
              toolCallId: 'call-visible',
              args: { path: 'large-file.ts' },
              result: { content: 'full raw content' },
            },
          },
          compactPart,
          { type: 'text', text: 'Compact tool result summary\ntool: read\n\nread\npath: old.ts' },
          { type: 'text', text: 'Here is the actual answer.' },
        ],
      },
    } as any, 'http://localhost');

    expect(uiMessage.parts).toHaveLength(2);
    expect(uiMessage.parts[0]).toMatchObject({ type: 'tool-read', output: { content: 'full raw content' } });
    expect(uiMessage.parts[1]).toEqual({ type: 'text', text: 'Here is the actual answer.' });
  });

  it('hides legacy leaked summaries without hiding ordinary assistant text', () => {
    const uiMessage = __chatStateContextUsageTest.toUiMessage({
      id: 'assistant-1',
      role: 'assistant',
      threadId: 'thread-1',
      resourceId: 'resource-1',
      createdAt: new Date(),
      content: {
        parts: [
          { type: 'text', text: 'read result:\nread\nok: true\npath: large-file.ts\ncontentHash: abc123' },
          { type: 'text', text: 'Compact tool result summary\ntool: read\n\nread\npath: old.ts' },
          { type: 'text', text: 'read result:\nThis phrase is part of a normal explanation.' },
        ],
      },
    } as any, 'http://localhost');

    expect(uiMessage.parts).toEqual([
      { type: 'text', text: 'read result:\nThis phrase is part of a normal explanation.' },
    ]);
  });

  it('preserves text/tool/text ordering and deterministic fallback tool ids', () => {
    const message = {
      id: 'assistant-ordered',
      role: 'assistant',
      threadId: 'thread-1',
      resourceId: 'resource-1',
      createdAt: new Date(),
      content: {
        parts: [
          { type: 'text', text: 'I will check that.' },
          {
            type: 'tool-call',
            toolName: 'bash',
            input: { command: 'pwd' },
            result: { stdout: '/tmp/project\n' },
          },
          { type: 'text', text: 'The project path is `/tmp/project`.' },
        ],
      },
    } as any;

    const first = __chatStateContextUsageTest.toUiMessage(message, 'http://localhost');
    const second = __chatStateContextUsageTest.toUiMessage(message, 'http://localhost');

    expect(first.parts).toEqual([
      { type: 'text', text: 'I will check that.' },
      {
        type: 'tool-bash',
        toolCallId: 'assistant-ordered-1-bash',
        state: 'output-available',
        input: { command: 'pwd' },
        output: { stdout: '/tmp/project\n' },
        errorText: undefined,
      },
      { type: 'text', text: 'The project path is `/tmp/project`.' },
    ]);
    expect(second.parts[1]).toMatchObject({ toolCallId: 'assistant-ordered-1-bash' });
  });
});

describe('current-turn image prompt shaping', () => {
  const imagePart = { type: 'file', mediaType: 'image/png', data: 'data:image/png;base64,aGVsbG8=' };
  const pdfPart = { type: 'file', mediaType: 'application/pdf', data: 'data:application/pdf;base64,cGRm' };

  it('strips historical user images while preserving historical text', () => {
    const processor = new CurrentTurnImageProcessor();
    const prompt = [
      { role: 'user', content: [{ type: 'text', text: 'Earlier text' }, imagePart] },
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier reply' }] },
      { role: 'user', content: [{ type: 'text', text: 'Current text' }] },
    ];

    const result = processor.processLLMRequest({ prompt, stepNumber: 0 } as any) as any;

    expect(countImageParts(result.prompt)).toBe(0);
    expect(result.prompt[0].content).toEqual([{ type: 'text', text: 'Earlier text' }]);
    expect(result.prompt.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'Current text' }] });
    expect(prompt[0].content).toContain(imagePart);
  });

  it('keeps only the latest user image on the initial model call', () => {
    const processor = new CurrentTurnImageProcessor();
    const prompt = [
      { role: 'user', content: [imagePart] },
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier reply' }] },
      { role: 'user', content: [{ type: 'text', text: 'Look at this' }, { ...imagePart, data: 'data:image/png;base64,bmV3' }] },
    ];

    const result = processor.processLLMRequest({ prompt, stepNumber: 0 } as any) as any;

    expect(countImageParts(result.prompt)).toBe(1);
    expect(result.prompt.includes(prompt[0])).toBe(false);
    expect(result.prompt.at(-1).content).toEqual([
      { type: 'text', text: 'Look at this' },
      { ...imagePart, data: 'data:image/png;base64,bmV3' },
    ]);
  });

  it('strips the latest user image on tool-continuation model calls', () => {
    const processor = new CurrentTurnImageProcessor();
    const prompt = [
      { role: 'user', content: [{ type: 'text', text: 'Look at this' }, imagePart] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'read', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'read', output: 'ok' }] },
    ];

    const result = processor.processLLMRequest({ prompt, stepNumber: 1 } as any) as any;

    expect(countImageParts(result.prompt)).toBe(0);
    expect(result.prompt[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Look at this' }] });
    expect(result.prompt.slice(1)).toEqual(prompt.slice(1));
  });

  it('preserves assistant tool content and non-image files', () => {
    const processor = new CurrentTurnImageProcessor();
    const prompt = [
      { role: 'user', content: [{ type: 'text', text: 'Earlier text' }, pdfPart, imagePart] },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'read', input: { path: 'a.ts' } }] },
      { role: 'user', content: [{ type: 'text', text: 'Current text' }] },
    ];

    const result = processor.processLLMRequest({ prompt, stepNumber: 0 } as any) as any;

    expect(result.prompt[0].content).toEqual([{ type: 'text', text: 'Earlier text' }, pdfPart]);
    expect(result.prompt[1]).toEqual(prompt[1]);
    expect(result.prompt[2]).toEqual(prompt[2]);
  });
});

describe('observational memory request shaping', () => {
  it('keeps only the latest user message when server-side memory owns history', () => {
    expect(__chatRouteMemoryTest.latestUserMessageOnly([
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'current' },
    ])).toEqual([{ role: 'user', content: 'current' }]);
  });

  it('trims memory-backed submitted history before image normalization', () => {
    const current = {
      role: 'user',
      parts: [
        { type: 'text', text: 'Current image' },
        { type: 'file', mimeType: 'image/png', filename: 'current.png', data: 'data:image/png;base64,Y3VycmVudA==' },
      ],
    };
    const messages = [
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'Old image' },
          { type: 'file', mimeType: 'image/png', filename: 'old.png', data: 'data:image/png;base64,b2xk' },
        ],
      },
      { role: 'assistant', parts: [{ type: 'text', text: 'Reply' }] },
      current,
    ];

    expect(__chatRouteMemoryTest.submittedMessagesForMemory(messages, 'thread-1')).toEqual([current]);
    expect(__chatRouteMemoryTest.submittedMessagesForMemory(messages, undefined)).toBe(messages);
  });

  it('stores a current data-url image attachment and exposes it as a pending UI file part', async () => {
    const storedPayloads: any[] = [];
    const normalized = await __chatRouteMemoryTest.normalizeMessageImageAttachments([
      {
        id: 'user-current',
        role: 'user',
        parts: [
          { type: 'text', text: 'Current image' },
          { type: 'file', mimeType: 'image/png', filename: 'current.png', data: 'data:image/png;base64,Y3VycmVudA==' },
        ],
      },
    ], {
      threadId: 'thread-1',
      storage: {
        findByThread: async () => [],
        put: async (payload: any) => {
          storedPayloads.push(payload);
          return {
            id: 'att_current',
            urlPath: '/attachments/att_current',
            mimeType: payload.mimeType,
            sizeBytes: payload.bytes.byteLength,
            originalName: payload.originalName,
          };
        },
      },
    }) as any[];

    expect(storedPayloads).toHaveLength(1);
    expect(storedPayloads[0]).toMatchObject({
      mimeType: 'image/png',
      originalName: 'current.png',
      threadId: 'thread-1',
    });
    expect(normalized[0]).toMatchObject({
      parts: [{ type: 'text', text: 'Current image' }],
      experimental_attachments: [{ url: 'https://weave.local/attachments/att_current', contentType: 'image/png' }],
    });

    const pending = __chatStateContextUsageTest.toPendingSubmittedMessage(normalized[0], 'http://localhost', 0);
    expect(pending?.parts).toEqual([
      { type: 'text', text: 'Current image' },
      {
        type: 'file',
        url: 'http://localhost/attachments/att_current',
        mediaType: 'image/png',
        metadata: { attachmentId: 'att_current', attachmentUrlPath: '/attachments/att_current' },
      },
    ]);
  });

  it('strips display-only reasoning and data parts before submitting history to Mastra', () => {
    expect(__chatRouteMemoryTest.sanitizeSubmittedMessagesForMastra([
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'Visible reasoning summary.' },
          { type: 'data-context-usage', data: { tokens: 12 } },
          { type: 'text', text: 'Actual response.' },
        ],
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'Only display text.' },
        ],
      },
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Continue.' }],
      },
    ])).toEqual([
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Actual response.' }],
      },
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Continue.' }],
      },
    ]);
  });
});
