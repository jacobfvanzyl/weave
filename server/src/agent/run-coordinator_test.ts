import {
  AgentRunCoordinator,
  type AgentThreadRun,
  bufferAssistantTextStream,
  filterCompactToolHistoryTextStream,
  normalizeAskUserSuspensionStream,
} from './run-coordinator.ts';
import type { AgentRunEventV1, AgentRunRecordV1 } from './run-repository.ts';

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  const actualJson = JSON.stringify(stable(actual));
  const expectedJson = JSON.stringify(stable(expected));
  if (actualJson !== expectedJson) {
    throw new Error(message ?? `Expected ${actualJson} to equal ${expectedJson}`);
  }
};

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]),
  );
};

const assertRejects = async (operation: () => Promise<unknown>, expectedMessage: string) => {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(expectedMessage)) return;
    throw new Error(`Expected rejection message to include "${expectedMessage}", got "${message}"`);
  }
  throw new Error(`Expected operation to reject with "${expectedMessage}"`);
};

const waitFor = async (predicate: () => boolean, message: string) => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
};

const createTestCoordinator = () => {
  let contextUsageListener: ((snapshot: any) => void) | undefined;
  let unsubscribeCount = 0;
  const coordinator = new AgentRunCoordinator({
    cleanupDelayMs: 5,
    createPerf: () => undefined,
    subscribeContextUsage: (_threadId, _resourceId, listener) => {
      contextUsageListener = listener;
      return () => {
        unsubscribeCount += 1;
      };
    },
  });

  return {
    coordinator,
    emitContextUsage: (snapshot: any) => contextUsageListener?.(snapshot),
    unsubscribeCount: () => unsubscribeCount,
  };
};

const rawAskUserSuspensionChunk = {
  type: 'data-tool-call-suspended',
  data: {
    state: 'data-tool-call-suspended',
    runId: 'mastra-run-1',
    toolCallId: 'ask-1',
    toolName: 'ask_user',
    suspendPayload: {
      requestedAt: '2026-07-07T10:00:00.000Z',
      questions: [
        {
          id: 'scope',
          header: 'Scope',
          question: 'How broad should this be?',
          options: [
            { id: 'narrow', label: 'Narrow', description: 'Only the current path.' },
            { id: 'broad', label: 'Broad', description: 'Include adjacent surfaces.' },
          ],
        },
      ],
    },
  },
};

const normalizedAskUserPart = {
  type: 'data-ask-user',
  id: 'ask-1',
  data: {
    mastraRunId: 'mastra-run-1',
    toolCallId: 'ask-1',
    toolName: 'ask_user',
    questions: [
      {
        id: 'scope',
        header: 'Scope',
        question: 'How broad should this be?',
        options: [
          { id: 'narrow', label: 'Narrow', description: 'Only the current path.' },
          { id: 'broad', label: 'Broad', description: 'Include adjacent surfaces.' },
        ],
      },
    ],
    status: 'pending',
    requestedAt: '2026-07-07T10:00:00.000Z',
  },
};

Deno.test('AgentRunCoordinator creates active run snapshots and submitted message retention', () => {
  const { coordinator } = createTestCoordinator();
  try {
    const submitted = { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'keep me' }] };
    const run = coordinator.createThreadRun('resource-1', 'thread-1', [submitted]);

    assert(coordinator.hasActiveThreadRun('resource-1', 'thread-1'), 'expected active run');
    assertEquals(coordinator.getThreadRun('resource-1', 'thread-1')?.runId, run.runId);
    assertEquals(coordinator.getSubmittedUserMessages('resource-1', 'thread-1'), [submitted]);
    assertEquals(coordinator.getThreadRunSnapshot('resource-1', 'thread-1').active, true);
    assertEquals(coordinator.getThreadRunSnapshot('other-resource', 'thread-1'), { active: false, status: 'idle' });
  } finally {
    coordinator.clearForTests();
  }
});

Deno.test('AgentRunCoordinator surfaces a run-record persistence failure before execution starts', async () => {
  const coordinator = new AgentRunCoordinator({
    repository: {
      create: async () => {
        throw new Error('database unavailable');
      },
    } as any,
  });
  const run = coordinator.createThreadRun('resource-1', 'thread-1');
  await assertRejects(() => coordinator.flushPersistence(run), 'database unavailable');
});

Deno.test('AgentRunCoordinator persists phase changes and owns one background execution', async () => {
  const metadataUpdates: Record<string, unknown>[] = [];
  const coordinator = new AgentRunCoordinator({
    subscribeContextUsage: () => () => undefined,
    repository: {
      create: async () => undefined,
      updateMetadata: async (_runId: string, metadata: Record<string, unknown>) => {
        metadataUpdates.push(metadata);
      },
    } as any,
  });
  let releaseExecution: () => void = () => undefined;
  const executionGate = new Promise<void>((resolve) => {
    releaseExecution = resolve;
  });
  let executionCount = 0;
  try {
    const run = coordinator.createThreadRun('resource-1', 'thread-1', [], { phase: 'compacting' });
    const first = coordinator.startRunExecution(run, async () => {
      executionCount += 1;
      await executionGate;
    });
    const duplicate = coordinator.startRunExecution(run, async () => {
      executionCount += 1;
    });
    assert(first === duplicate, 'duplicate ownership must return the same execution promise');
    coordinator.setPhase(run, 'generating');
    await coordinator.flushPersistence(run);
    assertEquals(executionCount, 1);
    assertEquals(coordinator.getThreadRunSnapshot('resource-1', 'thread-1').phase, 'generating');
    assertEquals(metadataUpdates, [{ phase: 'generating' }]);
    releaseExecution();
    await first;
  } finally {
    coordinator.clearForTests();
  }
});

Deno.test('AgentRunCoordinator keeps only one current run per resource/thread key', () => {
  const { coordinator, unsubscribeCount } = createTestCoordinator();
  try {
    const first = coordinator.createThreadRun('resource-1', 'thread-1');
    const second = coordinator.createThreadRun('resource-1', 'thread-1');

    assert(first.runId !== second.runId, 'expected new run id');
    assertEquals(coordinator.getThreadRun('resource-1', 'thread-1')?.runId, second.runId);
    assertEquals(unsubscribeCount(), 1);
  } finally {
    coordinator.clearForTests();
  }
});

Deno.test('AgentRunCoordinator replays retained chunks and continues with live chunks', async () => {
  const { coordinator } = createTestCoordinator();
  try {
    const run = coordinator.createThreadRun('resource-1', 'thread-1');
    const startChunk = { type: 'text-start', id: 'text-1' };
    const textChunk = { type: 'text-delta', id: 'text-1', delta: 'hello' };
    const finishChunk = { type: 'finish' };

    coordinator.appendChunk(run, startChunk);
    coordinator.appendChunk(run, textChunk);

    const reader = coordinator.observeRun(run).getReader();
    assertEquals(await reader.read(), { done: false, value: startChunk });
    assertEquals(await reader.read(), { done: false, value: textChunk });

    const liveRead = reader.read();
    coordinator.appendChunk(run, finishChunk);
    assertEquals(await liveRead, { done: false, value: finishChunk });

    const closeRead = reader.read();
    coordinator.completeRun(run);
    assertEquals(await closeRead, { done: true });
  } finally {
    coordinator.clearForTests();
  }
});

Deno.test('AgentRunCoordinator cancellation emits abort, aborts controller, and settles cancelled', async () => {
  const { coordinator, unsubscribeCount } = createTestCoordinator();
  try {
    const run = coordinator.createThreadRun('resource-1', 'thread-1');
    const reader = coordinator.observeRun(run).getReader();
    const abortRead = reader.read();

    assertEquals(coordinator.cancelRun(run), true);
    assert(run.controller.signal.aborted, 'expected run controller to be aborted');
    assertEquals(await abortRead, { done: false, value: { type: 'abort', reason: 'cancelled' } });
    assertEquals(await reader.read(), { done: true });
    assertEquals(coordinator.cancelRun(run), false);
    assertEquals(coordinator.getThreadRunSnapshot('resource-1', 'thread-1').status, 'cancelled');
    assertEquals(unsubscribeCount(), 1);
  } finally {
    coordinator.clearForTests();
  }
});

Deno.test('AgentRunCoordinator pump completes successful streams', async () => {
  const { coordinator } = createTestCoordinator();
  try {
    const run = coordinator.createThreadRun('resource-1', 'thread-1');
    coordinator.startRunPump(
      run,
      new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'finish' });
          controller.close();
        },
      }),
    );

    await waitFor(
      () => coordinator.getThreadRunSnapshot('resource-1', 'thread-1').status === 'completed',
      'expected run to complete',
    );
    assertEquals(coordinator.getThreadRunSnapshot('resource-1', 'thread-1').active, false);
  } finally {
    coordinator.clearForTests();
  }
});

Deno.test('normalizeAskUserSuspensionStream converts raw Mastra ask suspensions to chat data parts', async () => {
  const reader = normalizeAskUserSuspensionStream(
    new ReadableStream({
      start(controller) {
        controller.enqueue(rawAskUserSuspensionChunk);
        controller.close();
      },
    }),
  ).getReader();

  assertEquals(await reader.read(), {
    done: false,
    value: normalizedAskUserPart,
  });
  assertEquals(await reader.read(), { done: true });
});

Deno.test('normalizeAskUserSuspensionStream converts ask_user tool input chunks to chat data parts', async () => {
  const reader = normalizeAskUserSuspensionStream(
    new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: 'tool-input-available',
          toolCallId: 'ask-1',
          toolName: 'ask_user',
          input: {
            questions: [
              {
                id: 'scope',
                header: 'Scope',
                question: 'How broad should this be?',
                options: [
                  { id: 'narrow', label: 'Narrow', description: 'Only the current path.' },
                  { id: 'broad', label: 'Broad', description: 'Include adjacent surfaces.' },
                ],
              },
            ],
          },
        });
        controller.close();
      },
    }),
    { mastraRunId: 'mastra-run-1' },
  ).getReader();

  const { requestedAt: _requestedAt, ...expectedData } = normalizedAskUserPart.data;
  assertEquals(await reader.read(), {
    done: false,
    value: {
      type: 'data-ask-user',
      id: 'ask-1',
      data: expectedData,
    },
  });
  assertEquals(await reader.read(), { done: true });
});

Deno.test('AgentRunCoordinator pump completes local run when ask_user suspends', async () => {
  const { coordinator } = createTestCoordinator();
  let controller: ReadableStreamDefaultController<unknown> | undefined;
  try {
    const run = coordinator.createThreadRun('resource-1', 'thread-1');
    const reader = coordinator.observeRun(run).getReader();

    coordinator.startRunPump(
      run,
      bufferAssistantTextStream(
        filterCompactToolHistoryTextStream(
          normalizeAskUserSuspensionStream(
            new ReadableStream({
              start(streamController) {
                controller = streamController;
              },
            }),
          ),
        ),
      ),
    );

    assert(controller, 'expected stream controller');
    controller.enqueue(rawAskUserSuspensionChunk);

    assertEquals(await reader.read(), {
      done: false,
      value: normalizedAskUserPart,
    });
    const finishRead = await reader.read();
    assertEquals(finishRead.done, false);
    assertEquals((finishRead.value as any).type, 'finish');
    assertEquals((finishRead.value as any).finishReason, 'tool-calls');
    assertEquals(await reader.read(), { done: true });
    assertEquals(coordinator.getThreadRunSnapshot('resource-1', 'thread-1').active, false);
    assertEquals(coordinator.getThreadRunSnapshot('resource-1', 'thread-1').status, 'completed');
  } finally {
    controller?.close();
    coordinator.clearForTests();
  }
});

Deno.test('AgentRunCoordinator pump marks runs errored when an error chunk is observed', async () => {
  const consoleError = console.error;
  console.error = () => undefined;
  const { coordinator } = createTestCoordinator();
  try {
    const run = coordinator.createThreadRun('resource-1', 'thread-1');
    const reader = coordinator.observeRun(run).getReader();
    const textChunk = { type: 'text-delta', id: 'text-1', delta: 'before failure' };
    const errorChunk = { type: 'error', errorText: 'Provider stream ended before completion.' };

    coordinator.startRunPump(
      run,
      new ReadableStream({
        start(controller) {
          controller.enqueue(textChunk);
          controller.enqueue(errorChunk);
          controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'after failure' });
          controller.close();
        },
      }),
    );

    assertEquals(await reader.read(), { done: false, value: textChunk });
    assertEquals(await reader.read(), { done: false, value: errorChunk });
    await assertRejects(() => reader.read(), 'Provider stream ended before completion.');
    assertEquals(coordinator.getThreadRunSnapshot('resource-1', 'thread-1').status, 'error');
    assertEquals(coordinator.getThreadRunSnapshot('resource-1', 'thread-1').error, errorChunk.errorText);

    const replayReader = coordinator.observeRun(run).getReader();
    assertEquals(await replayReader.read(), { done: false, value: textChunk });
    assertEquals(await replayReader.read(), { done: false, value: errorChunk });
    assertEquals(await replayReader.read(), { done: true });
  } finally {
    console.error = consoleError;
    coordinator.clearForTests();
  }
});

Deno.test('AgentRunCoordinator persists context usage chunks and unsubscribes on settle', async () => {
  const { coordinator, emitContextUsage, unsubscribeCount } = createTestCoordinator();
  try {
    const run = coordinator.createThreadRun('resource-1', 'thread-1');
    const reader = coordinator.observeRun(run).getReader();
    const contextRead = reader.read();

    emitContextUsage({
      threadId: 'thread-1',
      resourceId: 'resource-1',
      usedTokens: 8_500,
      totalProcessedTokens: 9_100,
      inputTokens: 8_500,
      cachedInputTokens: 2_400,
      outputTokens: 600,
      updatedAt: '2026-07-05T10:00:00.000Z',
      source: 'provider',
    });

    assertEquals(await contextRead, {
      done: false,
      value: {
        type: 'data-context-usage',
        transient: true,
        data: {
          tokens: 8_500,
          inputTokens: 8_500,
          cachedInputTokens: 2_400,
          outputTokens: 600,
          totalProcessedTokens: 9_100,
          updatedAt: '2026-07-05T10:00:00.000Z',
          source: 'provider',
        },
      },
    });

    coordinator.completeRun(run);
    assertEquals(await reader.read(), { done: true });
    assertEquals(unsubscribeCount(), 1);

    const replayReader = coordinator.observeRun(run).getReader();
    const replayed = await replayReader.read();
    assertEquals(replayed.done, false);
    assertEquals((replayed.value as any).type, 'data-context-usage');
  } finally {
    coordinator.clearForTests();
  }
});

Deno.test('AgentRunCoordinator reconstructs assistant and steered user messages from retained chunks', () => {
  const { coordinator } = createTestCoordinator();
  try {
    const run = coordinator.createThreadRun('resource-1', 'thread-1');
    coordinator.appendChunk(run, { type: 'start', messageId: 'assistant-1' });
    coordinator.appendChunk(run, { type: 'text-start', id: 'text-1' });
    coordinator.appendChunk(run, { type: 'text-delta', id: 'text-1', delta: 'first answer' });
    coordinator.appendChunk(run, {
      type: 'data-user-message',
      transient: true,
      data: {
        id: 'steer-1',
        type: 'user',
        contents: 'Actually check the narrow case.',
        createdAt: '2026-07-05T10:00:00.000Z',
      },
    });
    coordinator.appendChunk(run, { type: 'start', messageId: 'assistant-2' });
    coordinator.appendChunk(run, { type: 'text-start', id: 'text-2' });
    coordinator.appendChunk(run, { type: 'text-delta', id: 'text-2', delta: 'second answer' });

    assertEquals(coordinator.getUiMessages('resource-1', 'thread-1'), [
      {
        id: 'assistant-1',
        role: 'assistant',
        status: { type: 'complete' },
        parts: [{ type: 'text', text: 'first answer' }],
      },
      {
        id: 'steer-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Actually check the narrow case.' }],
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        status: { type: 'running' },
        parts: [{ type: 'text', text: 'second answer' }],
      },
    ]);
  } finally {
    coordinator.clearForTests();
  }
});

Deno.test('AgentRunCoordinator reconstructs ask_user suspension parts from retained chunks', () => {
  const { coordinator } = createTestCoordinator();
  try {
    const run = coordinator.createThreadRun('resource-1', 'thread-1');
    coordinator.appendChunk(run, { type: 'start', messageId: 'assistant-1' });
    coordinator.appendChunk(run, {
      type: 'data-tool-call-suspended',
      data: {
        state: 'data-tool-call-suspended',
        runId: 'mastra-run-1',
        toolCallId: 'ask-1',
        toolName: 'ask_user',
        suspendPayload: {
          requestedAt: '2026-07-07T10:00:00.000Z',
          questions: [
            {
              id: 'scope',
              header: 'Scope',
              question: 'How broad should this be?',
              options: [
                { id: 'narrow', label: 'Narrow', description: 'Only the current path.' },
                { id: 'broad', label: 'Broad', description: 'Include adjacent surfaces.' },
              ],
            },
          ],
        },
      },
    });

    assertEquals(coordinator.getUiMessages('resource-1', 'thread-1'), [
      {
        id: 'assistant-1',
        role: 'assistant',
        status: { type: 'running' },
        parts: [
          {
            type: 'data-ask-user',
            id: 'ask-1',
            data: {
              mastraRunId: 'mastra-run-1',
              toolCallId: 'ask-1',
              toolName: 'ask_user',
              status: 'pending',
              requestedAt: '2026-07-07T10:00:00.000Z',
              questions: [
                {
                  id: 'scope',
                  header: 'Scope',
                  question: 'How broad should this be?',
                  options: [
                    { id: 'narrow', label: 'Narrow', description: 'Only the current path.' },
                    { id: 'broad', label: 'Broad', description: 'Include adjacent surfaces.' },
                  ],
                },
              ],
            },
          },
        ],
      },
    ]);

    coordinator.appendChunk(run, {
      type: 'tool-output-available',
      toolCallId: 'ask-1',
      toolName: 'ask_user',
      output: { ok: true },
    });
    const askPart = coordinator.getUiMessages('resource-1', 'thread-1')[0].parts[0] as any;
    assertEquals(askPart.data.status, 'submitted');
  } finally {
    coordinator.clearForTests();
  }
});

Deno.test('AgentRunCoordinator drops compact tool-history text from reconstructed assistant messages', () => {
  const { coordinator } = createTestCoordinator();
  try {
    const run = coordinator.createThreadRun('resource-1', 'thread-1');
    coordinator.appendChunk(run, { type: 'start', messageId: 'assistant-1' });
    coordinator.appendChunk(run, {
      type: 'tool-input-available',
      toolCallId: 'call-read',
      toolName: 'read',
      input: { path: 'src/example.ts' },
    });
    coordinator.appendChunk(run, {
      type: 'tool-output-available',
      toolCallId: 'call-read',
      output: { ok: true, path: 'src/example.ts', content: 'raw content' },
    });
    coordinator.appendChunk(run, { type: 'text-start', id: 'compact-text' });
    coordinator.appendChunk(run, {
      type: 'text-delta',
      id: 'compact-text',
      delta: 'read result:\nread\nok: true\npath: src/example.ts\ncontentHash: abc123',
    });
    coordinator.appendChunk(run, { type: 'text-end', id: 'compact-text' });
    coordinator.appendChunk(run, { type: 'text-start', id: 'answer-text' });
    coordinator.appendChunk(run, { type: 'text-delta', id: 'answer-text', delta: 'Done.' });

    assertEquals(coordinator.getUiMessages('resource-1', 'thread-1'), [
      {
        id: 'assistant-1',
        role: 'assistant',
        status: { type: 'running' },
        parts: [
          {
            type: 'tool-read',
            toolCallId: 'call-read',
            state: 'output-available',
            input: { path: 'src/example.ts' },
            output: { ok: true, path: 'src/example.ts', content: 'raw content' },
          },
          { type: 'text', text: 'Done.' },
        ],
      },
    ]);
  } finally {
    coordinator.clearForTests();
  }
});

Deno.test('filterCompactToolHistoryTextStream suppresses split compact tool-history deltas', async () => {
  const reader = filterCompactToolHistoryTextStream(
    new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'text-start', id: 'text-1' });
        controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'read result:\n' });
        controller.enqueue({
          type: 'text-delta',
          id: 'text-1',
          delta: 'read\nok: true\npath: src/example.ts\ncontentHash: abc123',
        });
        controller.enqueue({ type: 'text-end', id: 'text-1' });
        controller.enqueue({ type: 'finish' });
        controller.close();
      },
    }),
  ).getReader();

  assertEquals(await reader.read(), { done: false, value: { type: 'text-start', id: 'text-1' } });
  assertEquals(await reader.read(), { done: false, value: { type: 'text-end', id: 'text-1' } });
  assertEquals(await reader.read(), { done: false, value: { type: 'finish' } });
  assertEquals(await reader.read(), { done: true });
});

Deno.test('filterCompactToolHistoryTextStream suppresses parallel wrapper compact tool-history deltas', async () => {
  const reader = filterCompactToolHistoryTextStream(
    new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'text-start', id: 'text-1' });
        controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'multi_tool_use.parallel result:\n' });
        controller.enqueue({
          type: 'text-delta',
          id: 'text-1',
          delta: [
            'multi_tool_use.parallel ok: true results:',
            '',
            '- recipient_name: functions.read ok: true result: read ok: true path: lib/entities/enums.dart contentHash: abc123',
          ].join('\n'),
        });
        controller.enqueue({ type: 'text-end', id: 'text-1' });
        controller.enqueue({ type: 'finish' });
        controller.close();
      },
    }),
  ).getReader();

  assertEquals(await reader.read(), { done: false, value: { type: 'text-start', id: 'text-1' } });
  assertEquals(await reader.read(), { done: false, value: { type: 'text-end', id: 'text-1' } });
  assertEquals(await reader.read(), { done: false, value: { type: 'finish' } });
  assertEquals(await reader.read(), { done: true });
});

Deno.test('filterCompactToolHistoryTextStream suppresses git diff compact tool-history deltas', async () => {
  const reader = filterCompactToolHistoryTextStream(
    new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'text-start', id: 'text-1' });
        controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'git_diff result:\n' });
        controller.enqueue({
          type: 'text-delta',
          id: 'text-1',
          delta: [
            'git_diff ok: true contentChars: 519 contentHash: 8e76b34ccec3',
            '',
            'diff --git a/lib/entities/enums.dart b/lib/entities/enums.dart',
            '@@ -80,6 +80,10 @@ enum Entity {',
            '+  spreaderInstruction(',
            "+    label: 'Spreader Instruction',",
          ].join('\n'),
        });
        controller.enqueue({ type: 'text-end', id: 'text-1' });
        controller.enqueue({ type: 'finish' });
        controller.close();
      },
    }),
  ).getReader();

  assertEquals(await reader.read(), { done: false, value: { type: 'text-start', id: 'text-1' } });
  assertEquals(await reader.read(), { done: false, value: { type: 'text-end', id: 'text-1' } });
  assertEquals(await reader.read(), { done: false, value: { type: 'finish' } });
  assertEquals(await reader.read(), { done: true });
});

Deno.test('filterCompactToolHistoryTextStream suppresses leaked proposal function call text', async () => {
  const reader = filterCompactToolHistoryTextStream(
    new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'text-start', id: 'text-1' });
        controller.enqueue({
          type: 'text-delta',
          id: 'text-1',
          delta:
            'functions.proposal_read({"proposalPath":".agents/proposals/demo.md","path":"src/file.ts","offset":1,"limit":140})',
        });
        controller.enqueue({ type: 'text-end', id: 'text-1' });
        controller.enqueue({ type: 'finish' });
        controller.close();
      },
    }),
  ).getReader();

  assertEquals(await reader.read(), { done: false, value: { type: 'text-start', id: 'text-1' } });
  assertEquals(await reader.read(), { done: false, value: { type: 'text-end', id: 'text-1' } });
  assertEquals(await reader.read(), { done: false, value: { type: 'finish' } });
  assertEquals(await reader.read(), { done: true });
});

Deno.test('filterCompactToolHistoryTextStream releases ordinary assistant text containing result words', async () => {
  const firstDelta = { type: 'text-delta', id: 'text-1', delta: 'read result:\n' };
  const secondDelta = { type: 'text-delta', id: 'text-1', delta: 'This phrase is part of a normal explanation.' };
  const reader = filterCompactToolHistoryTextStream(
    new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'text-start', id: 'text-1' });
        controller.enqueue(firstDelta);
        controller.enqueue(secondDelta);
        controller.enqueue({ type: 'text-end', id: 'text-1' });
        controller.close();
      },
    }),
  ).getReader();

  assertEquals(await reader.read(), { done: false, value: { type: 'text-start', id: 'text-1' } });
  assertEquals(await reader.read(), { done: false, value: firstDelta });
  assertEquals(await reader.read(), { done: false, value: secondDelta });
  assertEquals(await reader.read(), { done: false, value: { type: 'text-end', id: 'text-1' } });
  assertEquals(await reader.read(), { done: true });
});

Deno.test('bufferAssistantTextStream flushes before user-message data chunks', async () => {
  const reader = bufferAssistantTextStream(
    new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'partial' });
        controller.enqueue({
          type: 'data-user-message',
          transient: true,
          data: {
            id: 'steer-1',
            type: 'user',
            contents: 'Steer now',
            createdAt: '2026-07-05T10:00:00.000Z',
          },
        });
        controller.close();
      },
    }),
  ).getReader();

  assertEquals(await reader.read(), {
    done: false,
    value: { type: 'text-delta', id: 'text-1', delta: 'partial' },
  });
  const userMessage = await reader.read();
  assertEquals(userMessage.done, false);
  assertEquals((userMessage.value as any).type, 'data-user-message');
  assertEquals((userMessage.value as any).transient, false);
  assertEquals(await reader.read(), { done: true });
});

Deno.test('AgentRunCoordinator pump flushes buffered assistant text before abort and marks stopped', async () => {
  const { coordinator } = createTestCoordinator();
  try {
    const run = coordinator.createThreadRun('resource-1', 'thread-1');
    coordinator.startRunPump(
      run,
      bufferAssistantTextStream(
        filterCompactToolHistoryTextStream(
          new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'start', messageId: 'assistant-1' });
              controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'partial' });
              controller.enqueue({ type: 'abort', reason: 'cancelled' });
              controller.close();
            },
          }),
        ),
      ),
    );

    await waitFor(
      () => coordinator.getThreadRunSnapshot('resource-1', 'thread-1').status === 'cancelled',
      'expected run to settle as cancelled',
    );
    assertEquals(run.chunks, [
      { type: 'start', messageId: 'assistant-1' },
      { type: 'text-delta', id: 'text-1', delta: 'partial' },
      { type: 'abort', reason: 'cancelled' },
    ]);
    assertEquals(coordinator.getUiMessages('resource-1', 'thread-1'), [
      {
        id: 'assistant-1',
        role: 'assistant',
        status: { type: 'complete', reason: 'stop' },
        parts: [{ type: 'text', text: 'partial' }],
      },
    ]);
  } finally {
    coordinator.clearForTests();
  }
});

Deno.test('AgentRunCoordinator restores an approval checkpoint without replaying a tool', () => {
  const { coordinator } = createTestCoordinator();
  const record: AgentRunRecordV1 = {
    version: 1,
    runId: 'run-restored',
    resourceId: 'resource-1',
    threadId: 'thread-restored',
    mastraRunId: 'mastra-restored',
    status: 'awaiting_approval',
    executionProfile: 'host',
    metadata: {},
    lastSequence: 2,
    startedAt: '2026-07-13T00:00:00.000Z',
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:01.000Z',
  };
  const events: AgentRunEventV1[] = [
    {
      version: 1,
      runId: record.runId,
      sequence: 1,
      eventId: 'event-1',
      eventType: 'tool-input-available',
      data: { type: 'tool-input-available', toolCallId: 'tool-1', toolName: 'bash' },
      createdAt: record.startedAt,
    },
    {
      version: 1,
      runId: record.runId,
      sequence: 2,
      eventId: 'event-2',
      eventType: 'tool-approval-request',
      data: { type: 'tool-approval-request', toolCallId: 'tool-1' },
      createdAt: record.updatedAt,
    },
  ];

  const run = coordinator.restoreAwaitingApprovalRun(record, events, { requestContext: { restored: true } });
  assertEquals(run.status, 'awaiting_approval');
  assertEquals(run.nextSequence, 2);
  assertEquals(run.chunks, events.map((event) => event.data));
  assertEquals(coordinator.getThreadRun('resource-1', 'thread-restored'), run);
});
