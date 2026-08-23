import { assertEquals } from 'jsr:@std/assert@1';
import type { JsonRpcMessage } from '@weave/protocol';
import type { AgentAttachInput, AgentAttachment, AgentRuntimePort } from './runtime.ts';
import { AcpSessionBroker } from './session-broker.ts';

const nextMessage = async (reader: ReadableStreamDefaultReader<JsonRpcMessage>) => {
  const next = await reader.read();
  if (next.done) throw new Error('ACP attachment closed before the expected message.');
  return next.value;
};

const responseId = (message: JsonRpcMessage) => 'id' in message ? message.id : undefined;

const updateKind = (message: JsonRpcMessage) =>
  'method' in message && message.method === 'session/update'
    ? (message.params as { update?: { sessionUpdate?: string } }).update?.sessionUpdate
    : undefined;

const updateText = (message: JsonRpcMessage) =>
  'method' in message && message.method === 'session/update'
    ? (message.params as { update?: { content?: { text?: string } } }).update?.content?.text
    : undefined;

const request = (id: number, method: string, params: Record<string, unknown>): JsonRpcMessage => ({
  jsonrpc: '2.0',
  id,
  method,
  params,
});

const fakeRuntime = (options: { echoUserPrompt?: boolean; holdPrompt?: boolean } = {}) => {
  let spawnCount = 0;
  let closeCount = 0;
  let releasePrompt: (() => void) | undefined;
  const promptGate = options.holdPrompt
    ? new Promise<void>((resolve) => {
      releasePrompt = resolve;
    })
    : Promise.resolve();
  const port: AgentRuntimePort = {
    listDefinitions: () => [{ id: 'fake', name: 'Fake Agent', command: 'fake' }],
    attach: async (input: AgentAttachInput): Promise<AgentAttachment> => {
      spawnCount += 1;
      let controller: ReadableStreamDefaultController<JsonRpcMessage> | undefined;
      const messages = new ReadableStream<JsonRpcMessage>({
        start(nextController) {
          controller = nextController;
        },
      });
      return {
        agentId: input.agentId,
        workspaceId: input.workspaceId ?? 'workspace-1',
        messages,
        stderrTail: () => '',
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
            controller!.enqueue({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'shared-session' } });
            return;
          }
          if (message.method === 'session/prompt') {
            const content = (message.params as { prompt: Array<{ text?: string; type?: string }> }).prompt[0] ?? {};
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
            controller!.enqueue({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
          }
        },
        close: async () => {
          closeCount += 1;
          controller?.close();
        },
      };
    },
  };
  return {
    port,
    spawnCount: () => spawnCount,
    closeCount: () => closeCount,
    releasePrompt: () => releasePrompt?.(),
  };
};

Deno.test('ACP session broker fans one hosted session out to simultaneous clients', async () => {
  const fake = fakeRuntime({ echoUserPrompt: true });
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
    assertEquals(responseId(await nextMessage(firstReader)), 1);
    await first.receive(request(2, 'session/new', { cwd: '/workspace', mcpServers: [] }));
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

    const second = await broker.attach({ ...input, transport: 'remote-acp', acpSessionId: 'shared-session' });
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
    await first.receive(request(2, 'session/new', { cwd: '/workspace', mcpServers: [] }));
    await nextMessage(firstReader);

    const second = await broker.attach({ ...input, transport: 'remote-acp', acpSessionId: 'shared-session' });
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
      assertEquals(updateKind(await nextMessage(firstReader)), 'agent_message_chunk');
      assertEquals(updateKind(await nextMessage(secondReader)), 'user_message_chunk');
      assertEquals(updateKind(await nextMessage(secondReader)), 'agent_message_chunk');

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
