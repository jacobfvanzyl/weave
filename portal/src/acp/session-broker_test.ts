import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import {
  type JsonRpcMessage,
  WEAVE_ACP_META_NAMESPACE,
  WEAVE_ACP_RUNTIME_STATE_NOTIFICATION,
  WEAVE_ACP_THREAD_ACK_METHOD,
  WEAVE_ACP_THREAD_EVENT_META_KEY,
  WEAVE_ACP_THREAD_EVENTS_META_KEY,
  WEAVE_ACP_THREAD_SYNC_NOTIFICATION,
} from '@weave/protocol';
import type { AgentAttachInput, AgentAttachment, AgentRuntimePort } from './runtime.ts';
import { InMemoryRuntimeStateStore } from './runtime-state.ts';
import { AcpSessionBroker } from './session-broker.ts';
import { InMemoryThreadEventJournal, type ThreadEventJournal } from './thread-event-journal.ts';

const nextMessage = async (
  reader: ReadableStreamDefaultReader<JsonRpcMessage>,
) => {
  const next = await reader.read();
  if (next.done) {
    throw new Error('ACP attachment closed before the expected message.');
  }
  return next.value;
};

const responseId = (message: JsonRpcMessage) => 'id' in message ? message.id : undefined;

const updateKind = (message: JsonRpcMessage) =>
  'method' in message && message.method === 'session/update'
    ? (message.params as { update?: { sessionUpdate?: string } }).update
      ?.sessionUpdate
    : undefined;

const updateText = (message: JsonRpcMessage) =>
  'method' in message && message.method === 'session/update'
    ? (message.params as { update?: { content?: { text?: string } } }).update
      ?.content?.text
    : undefined;

const threadEventSequence = (message: JsonRpcMessage) =>
  'method' in message && message.method === 'session/update'
    ? ((message.params as {
      update?: { _meta?: Record<string, { sequence?: number }> };
    }).update?._meta?.[
      WEAVE_ACP_THREAD_EVENT_META_KEY
    ]?.sequence)
    : undefined;

const request = (
  id: number,
  method: string,
  params: Record<string, unknown>,
): JsonRpcMessage => ({
  jsonrpc: '2.0',
  id,
  method,
  params,
});

const sessionUpdate = (
  sessionUpdate: string,
  text: string,
): JsonRpcMessage => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: 'shared-session',
    update: {
      sessionUpdate,
      content: { type: 'text', text },
    },
  },
});

const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for the fake ACP runtime.');
};

const fakeRuntime = (options: {
  echoUserPrompt?: boolean;
  holdPrompt?: boolean;
  holdLoad?: boolean;
  loadReplay?: JsonRpcMessage[];
} = {}) => {
  let spawnCount = 0;
  let closeCount = 0;
  let promptCount = 0;
  let loadCount = 0;
  let releasePrompt: (() => void) | undefined;
  let releaseLoad: (() => void) | undefined;
  const promptGate = options.holdPrompt
    ? new Promise<void>((resolve) => {
      releasePrompt = resolve;
    })
    : Promise.resolve();
  const loadGate = options.holdLoad
    ? new Promise<void>((resolve) => {
      releaseLoad = resolve;
    })
    : Promise.resolve();
  const port: AgentRuntimePort = {
    listDefinitions: () => [{ id: 'fake', name: 'Fake Agent', command: 'fake' }],
    attach: (input: AgentAttachInput): Promise<AgentAttachment> => {
      spawnCount += 1;
      let controller:
        | ReadableStreamDefaultController<JsonRpcMessage>
        | undefined;
      const messages = new ReadableStream<JsonRpcMessage>({
        start(nextController) {
          controller = nextController;
        },
      });
      return Promise.resolve({
        agentId: input.agentId,
        workspaceId: input.workspaceId ?? 'workspace-1',
        messages,
        stderrTail: () => '',
        finished: new Promise(() => undefined),
        receive: async (message) => {
          if (!('method' in message) || !('id' in message)) return;
          if (message.method === 'initialize') {
            controller!.enqueue({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: { loadSession: true },
                agentInfo: { name: 'fake', version: '1' },
                authMethods: [],
              },
            });
            return;
          }
          if (message.method === 'session/new') {
            controller!.enqueue({
              jsonrpc: '2.0',
              id: message.id,
              result: { sessionId: 'shared-session' },
            });
            return;
          }
          if (message.method === 'session/load') {
            loadCount += 1;
            for (const replayed of options.loadReplay ?? []) {
              controller!.enqueue(replayed);
            }
            await loadGate;
            controller!.enqueue({
              jsonrpc: '2.0',
              id: message.id,
              result: null,
            });
            return;
          }
          if (message.method === 'session/prompt') {
            promptCount += 1;
            const content = (message.params as {
              prompt: Array<{ text?: string; type?: string }>;
            }).prompt[0] ?? {};
            const text = content.text ?? '';
            if (options.echoUserPrompt) {
              controller!.enqueue({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: 'shared-session',
                  update: { sessionUpdate: 'user_message_chunk', content },
                },
              });
            }
            controller!.enqueue({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'shared-session',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: `reply:${text}` },
                },
              },
            });
            await promptGate;
            controller!.enqueue({
              jsonrpc: '2.0',
              id: message.id,
              result: { stopReason: 'end_turn' },
            });
          }
        },
        close: () => {
          closeCount += 1;
          controller?.close();
          return Promise.resolve();
        },
      });
    },
  };
  return {
    port,
    spawnCount: () => spawnCount,
    closeCount: () => closeCount,
    promptCount: () => promptCount,
    loadCount: () => loadCount,
    releasePrompt: () => releasePrompt?.(),
    releaseLoad: () => releaseLoad?.(),
  };
};

const recoverableFakeRuntime = (options: {
  resume?: boolean;
  resumeFails?: boolean;
  load?: boolean;
  recoveryReplay?: JsonRpcMessage[];
  holdFirstPrompt?: boolean;
} = {}) => {
  type Generation = {
    controller: ReadableStreamDefaultController<JsonRpcMessage>;
    finish: (exit: {
      success: boolean;
      code: number;
      signal?: string;
      error?: string;
      stderrTail: string;
    }) => void;
    finished: boolean;
    closed: boolean;
  };
  const generations: Generation[] = [];
  let promptCount = 0;
  let resumeCount = 0;
  let loadCount = 0;
  const port: AgentRuntimePort = {
    listDefinitions: () => [{ id: 'fake', name: 'Fake Agent', command: 'fake' }],
    attach: (input): Promise<AgentAttachment> => {
      let controller!: ReadableStreamDefaultController<JsonRpcMessage>;
      const messages = new ReadableStream<JsonRpcMessage>({
        start(nextController) {
          controller = nextController;
        },
      });
      let finish!: Generation['finish'];
      const finished = new Promise<Awaited<AgentAttachment['finished']>>(
        (resolve) => {
          finish = resolve;
        },
      );
      const generation: Generation = {
        controller,
        finish,
        finished: false,
        closed: false,
      };
      generations.push(generation);
      const generationNumber = generations.length;
      return Promise.resolve({
        agentId: input.agentId,
        workspaceId: input.workspaceId ?? 'workspace-1',
        messages,
        stderrTail: () => '',
        finished,
        receive: (message) => {
          if (!('method' in message) || !('id' in message)) {
            return Promise.resolve();
          }
          if (message.method === 'initialize') {
            controller.enqueue({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: {
                  ...(options.load ? { loadSession: true } : {}),
                  ...(options.resume ? { sessionCapabilities: { resume: {} } } : {}),
                },
                agentInfo: { name: 'recoverable-fake', version: '1' },
                authMethods: [],
              },
            });
            return Promise.resolve();
          }
          if (message.method === 'session/new') {
            controller.enqueue({
              jsonrpc: '2.0',
              id: message.id,
              result: { sessionId: 'shared-session' },
            });
            return Promise.resolve();
          }
          if (message.method === 'session/resume') {
            resumeCount += 1;
            controller.enqueue(
              options.resumeFails
                ? {
                  jsonrpc: '2.0',
                  id: message.id,
                  error: { code: -32050, message: 'resume failed' },
                }
                : { jsonrpc: '2.0', id: message.id, result: null },
            );
            return Promise.resolve();
          }
          if (message.method === 'session/load') {
            loadCount += 1;
            for (const replayed of options.recoveryReplay ?? []) {
              controller.enqueue(replayed);
            }
            controller.enqueue({
              jsonrpc: '2.0',
              id: message.id,
              result: null,
            });
            return Promise.resolve();
          }
          if (message.method === 'session/prompt') {
            promptCount += 1;
            const text = ((message.params as {
              prompt?: Array<{ text?: string }>;
            }).prompt?.[0]?.text) ?? '';
            controller.enqueue(
              sessionUpdate('agent_message_chunk', `reply:${text}`),
            );
            if (
              options.holdFirstPrompt && generationNumber === 1 &&
              promptCount === 1
            ) return Promise.resolve();
            controller.enqueue({
              jsonrpc: '2.0',
              id: message.id,
              result: { stopReason: 'end_turn' },
            });
          }
          return Promise.resolve();
        },
        close: () => {
          if (!generation.closed) {
            generation.closed = true;
            controller.close();
          }
          if (!generation.finished) {
            generation.finished = true;
            finish({ success: true, code: 0, stderrTail: '' });
          }
          return Promise.resolve();
        },
      });
    },
  };
  return {
    port,
    spawnCount: () => generations.length,
    promptCount: () => promptCount,
    resumeCount: () => resumeCount,
    loadCount: () => loadCount,
    finish: (
      index: number,
      exit = {
        success: false,
        code: 137,
        signal: 'SIGKILL',
        stderrTail: 'killed for acceptance',
      },
    ) => {
      const generation = generations[index];
      if (!generation || generation.finished) return;
      generation.finished = true;
      generation.finish(exit);
    },
    emit: (index: number, message: JsonRpcMessage) => generations[index]?.controller.enqueue(message),
  };
};

Deno.test('ACP session broker replaces an idle provider generation and fences stale output', async () => {
  const fake = recoverableFakeRuntime({ resume: true, load: true });
  const runtimeStateStore = new InMemoryRuntimeStateStore();
  const broker = new AcpSessionBroker(fake.port, { runtimeStateStore });
  const attachment = await broker.attach({
    agentId: 'fake',
    workspaceId: 'workspace-1',
    principalId: 'local',
    transport: 'stdio',
  });
  const reader = attachment.messages.getReader();
  const state = () =>
    runtimeStateStore.get({
      agentId: 'fake',
      workspaceId: 'workspace-1',
      acpSessionId: 'shared-session',
    });
  try {
    await attachment.receive(request(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'client', version: '1' },
    }));
    await nextMessage(reader);
    await attachment.receive(
      request(2, 'session/new', { cwd: '/workspace', mcpServers: [] }),
    );
    await nextMessage(reader);
    assertEquals((await state())?.generation, 1);
    await attachment.receive(request(3, 'session/prompt', {
      sessionId: 'shared-session',
      prompt: [{ type: 'text', text: 'seed' }],
    }));
    assertEquals(updateText(await nextMessage(reader)), 'reply:seed');
    assertEquals(responseId(await nextMessage(reader)), 3);
    await attachment.receive(request(4, 'session/load', {
      sessionId: 'shared-session',
      cwd: '/workspace',
      mcpServers: [],
      _meta: { [WEAVE_ACP_THREAD_EVENTS_META_KEY]: { afterSequence: 2 } },
    }));
    const initialSync = await nextMessage(reader);
    assertEquals(
      'method' in initialSync ? initialSync.method : undefined,
      WEAVE_ACP_THREAD_SYNC_NOTIFICATION,
    );
    assertEquals(responseId(await nextMessage(reader)), 4);

    fake.finish(0);
    await waitFor(() => fake.spawnCount() === 2 && fake.resumeCount() === 1);
    const exited = await nextMessage(reader);
    assertEquals(
      'method' in exited &&
        exited.method === WEAVE_ACP_RUNTIME_STATE_NOTIFICATION
        ? exited.params
        : undefined,
      {
        sessionId: 'shared-session',
        generation: 1,
        state: 'exited',
        code: 'PROCESS_EXITED',
        message: 'The Agent process exited and will be restored.',
      },
    );
    const restoring = await nextMessage(reader);
    assertEquals(
      'method' in restoring &&
        restoring.method === WEAVE_ACP_RUNTIME_STATE_NOTIFICATION
        ? restoring.params
        : undefined,
      {
        sessionId: 'shared-session',
        generation: 2,
        state: 'restoring',
        code: 'RESTORING',
        message: 'The Host is restoring the ACP provider session.',
      },
    );
    const recovered = await nextMessage(reader);
    assertEquals(
      'method' in recovered &&
        recovered.method === WEAVE_ACP_RUNTIME_STATE_NOTIFICATION
        ? recovered.params
        : undefined,
      {
        sessionId: 'shared-session',
        generation: 2,
        state: 'idle',
        code: 'RECOVERED',
        message: 'The ACP provider session was restored.',
      },
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await state())?.state === 'idle') break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const recoveredState = await state();
    assertEquals({
      ...recoveredState,
      updatedAt: '<timestamp>',
      lastExit: recoveredState?.lastExit ? { ...recoveredState.lastExit, occurredAt: '<timestamp>' } : undefined,
    }, {
      agentId: 'fake',
      workspaceId: 'workspace-1',
      acpSessionId: 'shared-session',
      generation: 2,
      state: 'idle',
      updatedAt: '<timestamp>',
      lastExit: {
        success: false,
        code: 137,
        signal: 'SIGKILL',
        stderrTail: 'killed for acceptance',
        occurredAt: '<timestamp>',
      },
    });
    assertEquals(fake.loadCount(), 0);

    fake.emit(0, sessionUpdate('agent_message_chunk', 'stale-generation'));
    await attachment.receive(request(5, 'session/prompt', {
      sessionId: 'shared-session',
      prompt: [{ type: 'text', text: 'after-recovery' }],
    }));
    assertEquals(updateText(await nextMessage(reader)), 'after-recovery');
    assertEquals(updateText(await nextMessage(reader)), 'reply:after-recovery');
    assertEquals(responseId(await nextMessage(reader)), 5);
  } finally {
    reader.releaseLock();
    await attachment.close();
    await broker.close();
  }
});

Deno.test('ACP session broker marks an interrupted prompt uncertain and recovers through load without replay fan-out', async () => {
  const fake = recoverableFakeRuntime({
    resume: true,
    resumeFails: true,
    load: true,
    holdFirstPrompt: true,
    recoveryReplay: [
      sessionUpdate('user_message_chunk', 'interrupted'),
      sessionUpdate('agent_message_chunk', 'provider-replay'),
    ],
  });
  const runtimeStateStore = new InMemoryRuntimeStateStore();
  const broker = new AcpSessionBroker(fake.port, { runtimeStateStore });
  const attachment = await broker.attach({
    agentId: 'fake',
    workspaceId: 'workspace-1',
    principalId: 'local',
    transport: 'stdio',
  });
  const reader = attachment.messages.getReader();
  try {
    await attachment.receive(request(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'client', version: '1' },
    }));
    await nextMessage(reader);
    await attachment.receive(
      request(2, 'session/new', { cwd: '/workspace', mcpServers: [] }),
    );
    await nextMessage(reader);

    await attachment.receive(request(3, 'session/prompt', {
      sessionId: 'shared-session',
      prompt: [{ type: 'text', text: 'interrupted' }],
    }));
    assertEquals(updateText(await nextMessage(reader)), 'reply:interrupted');
    fake.finish(0);
    const uncertain = await nextMessage(reader);
    assertEquals('error' in uncertain ? uncertain.error : undefined, {
      code: -32050,
      message: 'The Agent process exited after prompt delivery; completion is unknown.',
      data: { code: 'PROMPT_UNCERTAIN', generation: 1 },
    });

    await waitFor(() => fake.spawnCount() === 2 && fake.loadCount() === 1);
    await attachment.receive(request(4, 'session/prompt', {
      sessionId: 'shared-session',
      prompt: [{ type: 'text', text: 'explicit-retry' }],
    }));
    assertEquals(updateText(await nextMessage(reader)), 'reply:explicit-retry');
    assertEquals(responseId(await nextMessage(reader)), 4);
    assertEquals(fake.promptCount(), 2);
    assertEquals(fake.resumeCount(), 1);
  } finally {
    reader.releaseLock();
    await attachment.close();
    await broker.close();
  }
});

Deno.test('ACP session broker keeps the client stream open when a provider cannot resume', async () => {
  const fake = recoverableFakeRuntime();
  const runtimeStateStore = new InMemoryRuntimeStateStore();
  const broker = new AcpSessionBroker(fake.port, { runtimeStateStore });
  const attachment = await broker.attach({
    agentId: 'fake',
    workspaceId: 'workspace-1',
    principalId: 'local',
    transport: 'stdio',
  });
  const reader = attachment.messages.getReader();
  try {
    await attachment.receive(request(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'client', version: '1' },
    }));
    await nextMessage(reader);
    await attachment.receive(
      request(2, 'session/new', { cwd: '/workspace', mcpServers: [] }),
    );
    await nextMessage(reader);

    fake.finish(0);
    await waitFor(() => fake.spawnCount() === 2);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await runtimeStateStore.get({
        agentId: 'fake',
        workspaceId: 'workspace-1',
        acpSessionId: 'shared-session',
      });
      if (state?.state === 'unavailable') break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await attachment.receive(request(3, 'session/prompt', {
      sessionId: 'shared-session',
      prompt: [{ type: 'text', text: 'cannot-run' }],
    }));
    const unavailable = await nextMessage(reader);
    assertEquals('error' in unavailable ? unavailable.error : undefined, {
      code: -32050,
      message: 'The ACP session cannot currently be resumed.',
      data: { code: 'CANNOT_RESUME', generation: 2 },
    });

    await attachment.receive(request(4, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'client', version: '1' },
    }));
    assertEquals(responseId(await nextMessage(reader)), 4);
  } finally {
    reader.releaseLock();
    await attachment.close();
    await broker.close();
  }
});

Deno.test('ACP session broker advances the durable generation when a client reconnects after Host restart', async () => {
  const fake = recoverableFakeRuntime({ load: true });
  const runtimeStateStore = new InMemoryRuntimeStateStore();
  const eventJournal = new InMemoryThreadEventJournal();
  const input = {
    agentId: 'fake',
    workspaceId: 'workspace-1',
    principalId: 'local',
    transport: 'stdio' as const,
  };
  const stream = {
    agentId: 'fake',
    workspaceId: 'workspace-1',
    acpSessionId: 'shared-session',
  };

  const firstBroker = new AcpSessionBroker(fake.port, {
    eventJournal,
    runtimeStateStore,
  });
  const first = await firstBroker.attach(input);
  const firstReader = first.messages.getReader();
  await first.receive(request(1, 'initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'before-restart', version: '1' },
  }));
  await nextMessage(firstReader);
  await first.receive(
    request(2, 'session/new', { cwd: '/workspace', mcpServers: [] }),
  );
  await nextMessage(firstReader);
  assertEquals((await runtimeStateStore.get(stream))?.generation, 1);
  firstReader.releaseLock();
  await first.close();
  await firstBroker.close();

  const secondBroker = new AcpSessionBroker(fake.port, {
    eventJournal,
    runtimeStateStore,
  });
  const second = await secondBroker.attach({
    ...input,
    transport: 'remote-acp',
    acpSessionId: 'shared-session',
  });
  const secondReader = second.messages.getReader();
  try {
    assertEquals((await runtimeStateStore.get(stream))?.generation, 2);
    assertEquals((await runtimeStateStore.get(stream))?.state, 'restoring');
    await second.receive(request(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'after-restart', version: '1' },
    }));
    await nextMessage(secondReader);
    await second.receive(request(2, 'session/load', {
      sessionId: 'shared-session',
      cwd: '/workspace',
      mcpServers: [],
    }));
    assertEquals(responseId(await nextMessage(secondReader)), 2);
    assertEquals((await runtimeStateStore.get(stream))?.generation, 2);
    assertEquals((await runtimeStateStore.get(stream))?.state, 'idle');
  } finally {
    secondReader.releaseLock();
    await second.close();
    await secondBroker.close();
  }
});

Deno.test('ACP session broker fans one hosted session out to simultaneous clients', async () => {
  const fake = fakeRuntime({ echoUserPrompt: true });
  let eventId = 0;
  const eventJournal = new InMemoryThreadEventJournal({
    createId: () => `event-${++eventId}`,
  });
  const broker = new AcpSessionBroker(fake.port, { eventJournal });
  const input = {
    agentId: 'fake',
    workspaceId: 'workspace-1',
    principalId: 'local',
    transport: 'stdio' as const,
  };
  const first = await broker.attach(input);
  const firstReader = first.messages.getReader();

  try {
    await first.receive(request(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'first', version: '1' },
    }));
    assertEquals(responseId(await nextMessage(firstReader)), 1);
    await first.receive(
      request(2, 'session/new', { cwd: '/workspace', mcpServers: [] }),
    );
    assertEquals(await nextMessage(firstReader), {
      jsonrpc: '2.0',
      id: 2,
      result: { sessionId: 'shared-session' },
    });
    await first.receive(request(3, 'session/prompt', {
      sessionId: 'shared-session',
      prompt: [{ type: 'text', text: 'one' }],
    }));
    const firstReply = await nextMessage(firstReader);
    assertEquals(updateKind(firstReply), 'agent_message_chunk');
    assertEquals(updateText(firstReply), 'reply:one');
    assertEquals(responseId(await nextMessage(firstReader)), 3);

    const second = await broker.attach({
      ...input,
      transport: 'remote-acp',
      acpSessionId: 'shared-session',
    });
    const secondReader = second.messages.getReader();
    try {
      await second.receive(request(1, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'second', version: '1' },
      }));
      assertEquals(responseId(await nextMessage(secondReader)), 1);
      await second.receive(request(2, 'session/load', {
        sessionId: 'shared-session',
        cwd: '/workspace',
        mcpServers: [],
      }));
      const replayedUser = await nextMessage(secondReader);
      assertEquals(updateKind(replayedUser), 'user_message_chunk');
      assertEquals(updateText(replayedUser), 'one');
      const replayedReply = await nextMessage(secondReader);
      assertEquals(updateKind(replayedReply), 'agent_message_chunk');
      assertEquals(updateText(replayedReply), 'reply:one');
      assertEquals(responseId(await nextMessage(secondReader)), 2);
      assertEquals(fake.spawnCount(), 1);

      await second.receive(request(3, 'session/prompt', {
        sessionId: 'shared-session',
        prompt: [{ type: 'text', text: 'one' }],
      }));
      const observedUser = await nextMessage(firstReader);
      assertEquals(updateKind(observedUser), 'user_message_chunk');
      assertEquals(updateText(observedUser), 'one');
      const observedReply = await nextMessage(firstReader);
      assertEquals(updateKind(observedReply), 'agent_message_chunk');
      assertEquals(updateText(observedReply), 'reply:one');
      const originatingReply = await nextMessage(secondReader);
      assertEquals(updateKind(originatingReply), 'agent_message_chunk');
      assertEquals(updateText(originatingReply), 'reply:one');
      assertEquals(responseId(await nextMessage(secondReader)), 3);

      await first.close();
      assertEquals(fake.closeCount(), 0);
      await second.receive(request(4, 'session/prompt', {
        sessionId: 'shared-session',
        prompt: [{ type: 'text', text: 'three' }],
      }));
      const finalReply = await nextMessage(secondReader);
      assertEquals(updateKind(finalReply), 'agent_message_chunk');
      assertEquals(updateText(finalReply), 'reply:three');
      assertEquals(responseId(await nextMessage(secondReader)), 4);
      assertEquals(fake.spawnCount(), 1);
      const recorded = await eventJournal.list({
        agentId: 'fake',
        workspaceId: 'workspace-1',
        acpSessionId: 'shared-session',
      });
      assertEquals(
        recorded.map(({ sequence, eventId, message }) => ({
          sequence,
          eventId,
          kind: updateKind(message),
          text: updateText(message),
        })),
        [
          {
            sequence: 1,
            eventId: 'event-1',
            kind: 'user_message_chunk',
            text: 'one',
          },
          {
            sequence: 2,
            eventId: 'event-2',
            kind: 'agent_message_chunk',
            text: 'reply:one',
          },
          {
            sequence: 3,
            eventId: 'event-3',
            kind: 'user_message_chunk',
            text: 'one',
          },
          {
            sequence: 4,
            eventId: 'event-4',
            kind: 'agent_message_chunk',
            text: 'reply:one',
          },
          {
            sequence: 5,
            eventId: 'event-5',
            kind: 'user_message_chunk',
            text: 'three',
          },
          {
            sequence: 6,
            eventId: 'event-6',
            kind: 'agent_message_chunk',
            text: 'reply:three',
          },
        ],
      );
    } finally {
      secondReader.releaseLock();
      await second.close();
    }
  } finally {
    firstReader.releaseLock();
    await broker.close();
  }
  assertEquals(fake.closeCount(), 1);
});

Deno.test('ACP session broker rejects a competing prompt without hanging either client', async () => {
  const fake = fakeRuntime({ holdPrompt: true });
  const broker = new AcpSessionBroker(fake.port);
  const input = {
    agentId: 'fake',
    workspaceId: 'workspace-1',
    principalId: 'local',
    transport: 'stdio' as const,
  };
  const first = await broker.attach(input);
  const firstReader = first.messages.getReader();
  try {
    await first.receive(request(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'first', version: '1' },
    }));
    await nextMessage(firstReader);
    await first.receive(
      request(2, 'session/new', { cwd: '/workspace', mcpServers: [] }),
    );
    await nextMessage(firstReader);

    const second = await broker.attach({
      ...input,
      transport: 'remote-acp',
      acpSessionId: 'shared-session',
    });
    const secondReader = second.messages.getReader();
    try {
      await second.receive(request(1, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'second', version: '1' },
      }));
      await nextMessage(secondReader);
      await second.receive(request(2, 'session/load', {
        sessionId: 'shared-session',
        cwd: '/workspace',
        mcpServers: [],
      }));
      await nextMessage(secondReader);

      const activePrompt = first.receive(request(3, 'session/prompt', {
        sessionId: 'shared-session',
        prompt: [{ type: 'text', text: 'held' }],
      }));
      assertEquals(
        updateKind(await nextMessage(firstReader)),
        'agent_message_chunk',
      );
      assertEquals(
        updateKind(await nextMessage(secondReader)),
        'user_message_chunk',
      );
      assertEquals(
        updateKind(await nextMessage(secondReader)),
        'agent_message_chunk',
      );

      await second.receive(request(3, 'session/prompt', {
        sessionId: 'shared-session',
        prompt: [{ type: 'text', text: 'competing' }],
      }));
      const busy = await nextMessage(secondReader);
      assertEquals('error' in busy ? busy.error : undefined, {
        code: -32009,
        message: 'The ACP session already has an active prompt.',
        data: { code: 'SESSION_BUSY' },
      });

      fake.releasePrompt();
      await activePrompt;
      assertEquals(responseId(await nextMessage(firstReader)), 3);
    } finally {
      secondReader.releaseLock();
      await second.close();
    }
  } finally {
    firstReader.releaseLock();
    await first.close();
    await broker.close();
  }
});

Deno.test('ACP session broker does not deliver a prompt whose user event cannot be made durable', async () => {
  const fake = fakeRuntime();
  const eventJournal: ThreadEventJournal = {
    append: () => Promise.reject(new Error('journal unavailable')),
    list: () => Promise.resolve([]),
    read: () =>
      Promise.resolve({
        events: [],
        compactedThrough: 0,
        lastSequence: 0,
        cursorExpired: false,
      }),
  };
  const broker = new AcpSessionBroker(fake.port, { eventJournal });
  const attachment = await broker.attach({
    agentId: 'fake',
    workspaceId: 'workspace-1',
    principalId: 'local',
    transport: 'stdio',
  });
  const reader = attachment.messages.getReader();
  try {
    await attachment.receive(request(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'client', version: '1' },
    }));
    await nextMessage(reader);
    await attachment.receive(
      request(2, 'session/new', { cwd: '/workspace', mcpServers: [] }),
    );
    await nextMessage(reader);

    await assertRejects(
      () =>
        attachment.receive(request(3, 'session/prompt', {
          sessionId: 'shared-session',
          prompt: [{ type: 'text', text: 'must persist' }],
        })),
      Error,
      'journal unavailable',
    );
    assertEquals(fake.promptCount(), 0);
  } finally {
    reader.releaseLock();
    await attachment.close();
    await broker.close();
  }
});

Deno.test('ACP session broker reconstructs one cold runtime and replays its durable history once', async () => {
  let eventId = 0;
  const eventJournal = new InMemoryThreadEventJournal({
    createId: () => `event-${++eventId}`,
  });
  const input = {
    agentId: 'fake',
    workspaceId: 'workspace-1',
    principalId: 'local',
    transport: 'stdio' as const,
  };

  const originalFake = fakeRuntime({ echoUserPrompt: true });
  const originalBroker = new AcpSessionBroker(originalFake.port, {
    eventJournal,
  });
  const original = await originalBroker.attach(input);
  const originalReader = original.messages.getReader();
  try {
    await original.receive(request(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'original', version: '1' },
    }));
    await nextMessage(originalReader);
    await original.receive(
      request(2, 'session/new', { cwd: '/workspace', mcpServers: [] }),
    );
    await nextMessage(originalReader);
    await original.receive(request(3, 'session/prompt', {
      sessionId: 'shared-session',
      prompt: [{ type: 'text', text: 'one' }],
    }));
    assertEquals(updateText(await nextMessage(originalReader)), 'reply:one');
    assertEquals(responseId(await nextMessage(originalReader)), 3);
  } finally {
    originalReader.releaseLock();
    await original.close();
    await originalBroker.close();
  }

  const restoredFake = fakeRuntime({
    echoUserPrompt: true,
    holdLoad: true,
    loadReplay: [
      sessionUpdate('user_message_chunk', 'one'),
      sessionUpdate('agent_message_chunk', 'reply:one'),
    ],
  });
  const restoredBroker = new AcpSessionBroker(restoredFake.port, {
    eventJournal,
  });
  const [first, second] = await Promise.all([
    restoredBroker.attach({ ...input, acpSessionId: 'shared-session' }),
    restoredBroker.attach({
      ...input,
      transport: 'remote-acp',
      acpSessionId: 'shared-session',
    }),
  ]);
  const firstReader = first.messages.getReader();
  const secondReader = second.messages.getReader();
  try {
    await Promise.all([
      first.receive(request(1, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'first-restored', version: '1' },
      })),
      second.receive(request(1, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'second-restored', version: '1' },
      })),
    ]);
    assertEquals(responseId(await nextMessage(firstReader)), 1);
    assertEquals(responseId(await nextMessage(secondReader)), 1);

    const firstLoad = first.receive(request(2, 'session/load', {
      sessionId: 'shared-session',
      cwd: '/workspace',
      mcpServers: [],
    }));
    const secondLoad = second.receive(request(2, 'session/load', {
      sessionId: 'shared-session',
      cwd: '/workspace',
      mcpServers: [],
    }));
    await waitFor(() => restoredFake.loadCount() > 0);
    restoredFake.releaseLoad();
    await Promise.all([firstLoad, secondLoad]);

    for (const reader of [firstReader, secondReader]) {
      assertEquals(updateText(await nextMessage(reader)), 'one');
      assertEquals(updateText(await nextMessage(reader)), 'reply:one');
      assertEquals(responseId(await nextMessage(reader)), 2);
    }
    assertEquals(restoredFake.spawnCount(), 1);
    assertEquals(restoredFake.loadCount(), 1);
    assertEquals(
      (await eventJournal.list({
        agentId: 'fake',
        workspaceId: 'workspace-1',
        acpSessionId: 'shared-session',
      })).length,
      2,
    );

    await first.receive(request(3, 'session/prompt', {
      sessionId: 'shared-session',
      prompt: [{ type: 'text', text: 'two' }],
    }));
    assertEquals(updateText(await nextMessage(firstReader)), 'reply:two');
    assertEquals(responseId(await nextMessage(firstReader)), 3);
    assertEquals(updateText(await nextMessage(secondReader)), 'two');
    assertEquals(updateText(await nextMessage(secondReader)), 'reply:two');
    assertEquals(
      (await eventJournal.list({
        agentId: 'fake',
        workspaceId: 'workspace-1',
        acpSessionId: 'shared-session',
      })).length,
      4,
    );
  } finally {
    firstReader.releaseLock();
    secondReader.releaseLock();
    await first.close();
    await second.close();
    await restoredBroker.close();
  }
});

Deno.test('ACP session broker bootstraps an unjournaled session from provider load replay', async () => {
  let eventId = 0;
  const eventJournal = new InMemoryThreadEventJournal({
    createId: () => `event-${++eventId}`,
  });
  const fake = fakeRuntime({
    loadReplay: [
      sessionUpdate('user_message_chunk', 'legacy'),
      sessionUpdate('agent_message_chunk', 'reply:legacy'),
    ],
  });
  const broker = new AcpSessionBroker(fake.port, { eventJournal });
  const attachment = await broker.attach({
    agentId: 'fake',
    workspaceId: 'workspace-1',
    acpSessionId: 'shared-session',
    principalId: 'local',
    transport: 'remote-acp',
  });
  const reader = attachment.messages.getReader();
  try {
    await attachment.receive(request(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'legacy-client', version: '1' },
    }));
    assertEquals(responseId(await nextMessage(reader)), 1);
    await attachment.receive(request(2, 'session/load', {
      sessionId: 'shared-session',
      cwd: '/workspace',
      mcpServers: [],
    }));
    assertEquals(updateText(await nextMessage(reader)), 'legacy');
    assertEquals(updateText(await nextMessage(reader)), 'reply:legacy');
    assertEquals(responseId(await nextMessage(reader)), 2);

    assertEquals(fake.spawnCount(), 1);
    assertEquals(fake.loadCount(), 1);
    assertEquals(
      (await eventJournal.list({
        agentId: 'fake',
        workspaceId: 'workspace-1',
        acpSessionId: 'shared-session',
      })).map(({ sequence, eventId, message }) => ({
        sequence,
        eventId,
        text: updateText(message),
      })),
      [
        { sequence: 1, eventId: 'event-1', text: 'legacy' },
        { sequence: 2, eventId: 'event-2', text: 'reply:legacy' },
      ],
    );
  } finally {
    reader.releaseLock();
    await attachment.close();
    await broker.close();
  }
});

Deno.test('ACP session broker exposes native cursors and forces a provider reload after retention overflow', async () => {
  let eventId = 0;
  const eventJournal = new InMemoryThreadEventJournal({
    createId: () => `event-${++eventId}`,
    maxEventsPerStream: 2,
  });
  const input = {
    agentId: 'fake',
    workspaceId: 'workspace-1',
    principalId: 'local',
    transport: 'stdio' as const,
  };
  const originalFake = fakeRuntime({ echoUserPrompt: true });
  const originalBroker = new AcpSessionBroker(originalFake.port, {
    eventJournal,
  });
  const original = await originalBroker.attach(input);
  const originalReader = original.messages.getReader();
  try {
    await original.receive(request(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'original', version: '1' },
    }));
    await nextMessage(originalReader);
    await original.receive(
      request(2, 'session/new', { cwd: '/workspace', mcpServers: [] }),
    );
    await nextMessage(originalReader);
    for (const [id, text] of [[3, 'one'], [4, 'two']] as const) {
      await original.receive(request(id, 'session/prompt', {
        sessionId: 'shared-session',
        prompt: [{ type: 'text', text }],
      }));
      await nextMessage(originalReader);
      await nextMessage(originalReader);
    }
  } finally {
    originalReader.releaseLock();
    await original.close();
    await originalBroker.close();
  }

  const restoredFake = fakeRuntime({
    echoUserPrompt: true,
    loadReplay: [
      sessionUpdate('user_message_chunk', 'one'),
      sessionUpdate('agent_message_chunk', 'reply:one'),
      sessionUpdate('user_message_chunk', 'two'),
      sessionUpdate('agent_message_chunk', 'reply:two'),
    ],
  });
  const restoredBroker = new AcpSessionBroker(restoredFake.port, {
    eventJournal,
  });
  const restored = await restoredBroker.attach({
    ...input,
    acpSessionId: 'shared-session',
  });
  const restoredReader = restored.messages.getReader();
  try {
    await restored.receive(request(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'native', version: '1' },
    }));
    const initialized = await nextMessage(restoredReader);
    assertEquals(
      'result' in initialized
        ? (initialized.result as {
          agentCapabilities: { _meta: Record<string, unknown> };
        }).agentCapabilities._meta[
          WEAVE_ACP_META_NAMESPACE
        ]
        : undefined,
      {
        threadEvents: {
          version: 1,
          ackMethod: WEAVE_ACP_THREAD_ACK_METHOD,
          syncNotification: WEAVE_ACP_THREAD_SYNC_NOTIFICATION,
        },
        runtimeRecovery: {
          version: 1,
          stateNotification: WEAVE_ACP_RUNTIME_STATE_NOTIFICATION,
        },
      },
    );

    await restored.receive(request(2, 'session/load', {
      sessionId: 'shared-session',
      cwd: '/workspace',
      mcpServers: [],
      _meta: { [WEAVE_ACP_THREAD_EVENTS_META_KEY]: { afterSequence: 1 } },
    }));
    const expired = await nextMessage(restoredReader);
    assertEquals('error' in expired ? expired.error : undefined, {
      code: -32060,
      message: 'The requested Thread event cursor has expired.',
      data: {
        code: 'RESUME_GAP',
        compactedThrough: 2,
        lastSequence: 4,
        reloadAfterSequence: null,
      },
    });
    assertEquals(restoredFake.loadCount(), 0);

    await restored.receive(request(3, 'session/load', {
      sessionId: 'shared-session',
      cwd: '/workspace',
      mcpServers: [],
      _meta: { [WEAVE_ACP_THREAD_EVENTS_META_KEY]: { afterSequence: null } },
    }));
    assertEquals(updateText(await nextMessage(restoredReader)), 'one');
    assertEquals(updateText(await nextMessage(restoredReader)), 'reply:one');
    assertEquals(updateText(await nextMessage(restoredReader)), 'two');
    assertEquals(updateText(await nextMessage(restoredReader)), 'reply:two');
    const sync = await nextMessage(restoredReader);
    assertEquals('method' in sync ? sync : undefined, {
      jsonrpc: '2.0',
      method: WEAVE_ACP_THREAD_SYNC_NOTIFICATION,
      params: {
        sessionId: 'shared-session',
        lastSequence: 4,
        fullReload: true,
      },
    });
    assertEquals(responseId(await nextMessage(restoredReader)), 3);

    await restored.receive(request(4, 'session/prompt', {
      sessionId: 'shared-session',
      prompt: [{ type: 'text', text: 'three' }],
    }));
    const submitted = await nextMessage(restoredReader);
    assertEquals(updateText(submitted), 'three');
    assertEquals(threadEventSequence(submitted), 5);
    const replied = await nextMessage(restoredReader);
    assertEquals(updateText(replied), 'reply:three');
    assertEquals(threadEventSequence(replied), 6);
    assertEquals(responseId(await nextMessage(restoredReader)), 4);

    await restored.receive(request(5, WEAVE_ACP_THREAD_ACK_METHOD, {
      sessionId: 'shared-session',
      sequence: 6,
    }));
    assertEquals(await nextMessage(restoredReader), {
      jsonrpc: '2.0',
      id: 5,
      result: { acknowledgedSequence: 6 },
    });
  } finally {
    restoredReader.releaseLock();
    await restored.close();
    await restoredBroker.close();
  }
});

Deno.test('ACP session broker hands replay to the live stream without losing a concurrent event', async () => {
  const baseJournal = new InMemoryThreadEventJournal();
  let readCount = 0;
  let heldRead = 0;
  let releaseRead: (() => void) | undefined;
  let reportHeldRead: (() => void) | undefined;
  const readHeld = new Promise<void>((resolve) => {
    reportHeldRead = resolve;
  });
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const eventJournal: ThreadEventJournal = {
    append: (stream, message) => baseJournal.append(stream, message),
    list: (stream, options) => baseJournal.list(stream, options),
    read: async (stream, options) => {
      const result = await baseJournal.read(stream, options);
      readCount += 1;
      if (readCount === heldRead) {
        reportHeldRead?.();
        await readGate;
      }
      return result;
    },
  };
  const fake = fakeRuntime({ echoUserPrompt: true });
  const broker = new AcpSessionBroker(fake.port, { eventJournal });
  const input = {
    agentId: 'fake',
    workspaceId: 'workspace-1',
    principalId: 'local',
    transport: 'stdio' as const,
  };
  const first = await broker.attach(input);
  const firstReader = first.messages.getReader();
  try {
    await first.receive(request(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'first', version: '1' },
    }));
    await nextMessage(firstReader);
    await first.receive(
      request(2, 'session/new', { cwd: '/workspace', mcpServers: [] }),
    );
    await nextMessage(firstReader);
    await first.receive(request(3, 'session/prompt', {
      sessionId: 'shared-session',
      prompt: [{ type: 'text', text: 'before' }],
    }));
    await nextMessage(firstReader);
    await nextMessage(firstReader);

    const second = await broker.attach({
      ...input,
      transport: 'remote-acp',
      acpSessionId: 'shared-session',
    });
    const secondReader = second.messages.getReader();
    try {
      await second.receive(request(1, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'second', version: '1' },
      }));
      await nextMessage(secondReader);
      heldRead = readCount + 2;
      const load = second.receive(request(2, 'session/load', {
        sessionId: 'shared-session',
        cwd: '/workspace',
        mcpServers: [],
        _meta: { [WEAVE_ACP_THREAD_EVENTS_META_KEY]: { afterSequence: 0 } },
      }));
      await readHeld;
      const concurrentPrompt = first.receive(request(4, 'session/prompt', {
        sessionId: 'shared-session',
        prompt: [{ type: 'text', text: 'during' }],
      }));
      releaseRead?.();
      await Promise.all([load, concurrentPrompt]);

      assertEquals(updateText(await nextMessage(secondReader)), 'before');
      assertEquals(updateText(await nextMessage(secondReader)), 'reply:before');
      const sync = await nextMessage(secondReader);
      assertEquals(
        'method' in sync ? sync.method : undefined,
        WEAVE_ACP_THREAD_SYNC_NOTIFICATION,
      );
      const during = await nextMessage(secondReader);
      assertEquals(updateText(during), 'during');
      assertEquals(threadEventSequence(during), 3);
      assertEquals(responseId(await nextMessage(secondReader)), 2);
      const duringReply = await nextMessage(secondReader);
      assertEquals(updateText(duringReply), 'reply:during');
      assertEquals(threadEventSequence(duringReply), 4);
      assertEquals(updateText(await nextMessage(firstReader)), 'reply:during');
      assertEquals(responseId(await nextMessage(firstReader)), 4);
    } finally {
      secondReader.releaseLock();
      await second.close();
    }
  } finally {
    firstReader.releaseLock();
    await first.close();
    await broker.close();
  }
});
