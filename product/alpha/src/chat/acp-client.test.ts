import { describe, expect, it, vi } from 'vitest';
import type { WebSocketConstructor } from '@agentclientprotocol/sdk/experimental/ws-client';
import {
  AcpSessionClient,
  parseAcpClientMessage,
} from './acp-client';

class FakeWebSocket {
  static latest?: FakeWebSocket;

  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.latest = this;
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close() {
    this.readyState = 3;
    this.emit('close', {});
  }

  open() {
    this.readyState = 1;
    this.emit('open', {});
  }

  receive(message: Record<string, unknown>) {
    this.emit('message', { data: JSON.stringify(message) });
  }

  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const waitForSent = async (socket: FakeWebSocket, count: number) => {
  for (let attempt = 0; attempt < 20 && socket.sent.length < count; attempt += 1) {
    await Promise.resolve();
  }
  expect(socket.sent.length).toBeGreaterThanOrEqual(count);
};

const waitForCalls = async (mock: ReturnType<typeof vi.fn>, count: number) => {
  for (let attempt = 0; attempt < 20 && mock.mock.calls.length < count; attempt += 1) {
    await Promise.resolve();
  }
  expect(mock.mock.calls.length).toBeGreaterThanOrEqual(count);
};

describe('parseAcpClientMessage', () => {
  it('validates the JSON-RPC envelope while preserving extension payloads', () => {
    expect(parseAcpClientMessage(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: '_vendor_update',
          nested: { retained: true },
          _meta: { vendor: 'weave' },
        },
      },
    }))).toMatchObject({
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: '_vendor_update',
          nested: { retained: true },
          _meta: { vendor: 'weave' },
        },
      },
    });

    expect(() => parseAcpClientMessage('{')).toThrow('valid JSON');
    expect(() => parseAcpClientMessage('[]')).toThrow('JSON-RPC object');
    expect(() => parseAcpClientMessage('{"jsonrpc":"1.0"}')).toThrow('JSON-RPC 2.0');
  });
});

describe('AcpSessionClient', () => {
  it('uses typed ACP dispatch and resolves permission and elicitation requests', async () => {
    const onEvent = vi.fn();
    const channel = new AcpSessionClient({
      url: 'ws://portal.test/acp',
      protocols: ['weave.portal.token.test'],
      WebSocket: FakeWebSocket as unknown as WebSocketConstructor,
      onEvent,
    });
    const socket = FakeWebSocket.latest!;
    socket.open();

    const attach = channel.initializeAndLoad({
      sessionId: 'session-1',
      cwd: '/workspace',
    });
    await waitForSent(socket, 1);
    expect(socket.sent[0]).toMatchObject({
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          elicitation: { form: {}, url: {} },
          plan: {},
          session: { compaction: {}, configOptions: { boolean: {} } },
        },
      },
    });
    socket.receive({
      jsonrpc: '2.0',
      id: socket.sent[0].id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    });
    await waitForSent(socket, 2);
    expect(socket.sent[1]).toMatchObject({
      method: 'session/load',
      params: { sessionId: 'session-1', cwd: '/workspace', mcpServers: [] },
    });
    socket.receive({
      jsonrpc: '2.0',
      id: socket.sent[1].id,
      result: {
        modes: {
          currentModeId: 'code',
          availableModes: [{ id: 'code', name: 'Code' }],
        },
        configOptions: [],
      },
    });
    await attach;
    expect(onEvent).toHaveBeenCalledWith({
      type: 'session/loaded',
      modes: {
        currentModeId: 'code',
        availableModes: [{ id: 'code', name: 'Code' }],
      },
      configOptions: [],
    });

    socket.receive({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'answer-1',
          content: { type: 'text', text: 'Hello' },
        },
      },
    });
    socket.receive({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: '_vendor_progress',
          detail: { retained: true },
        },
      },
    });
    socket.receive({
      jsonrpc: '2.0',
      id: 'permission-wire-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'session-1',
        toolCall: { toolCallId: 'tool-1', title: 'Run tests' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      },
    });
    socket.receive({
      jsonrpc: '2.0',
      id: 'elicitation-wire-1',
      method: 'elicitation/create',
      params: {
        mode: 'url',
        sessionId: 'session-1',
        elicitationId: 'sign-in',
        url: 'https://example.com/sign-in',
        message: 'Sign in',
      },
    });
    await waitForCalls(onEvent, 5);

    expect(onEvent).toHaveBeenCalledWith({
      type: 'session/update',
      update: expect.objectContaining({ sessionUpdate: 'agent_message_chunk' }),
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: 'protocol/unknown',
      method: 'session/update',
      payload: expect.objectContaining({
        update: {
          sessionUpdate: '_vendor_progress',
          detail: { retained: true },
        },
      }),
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: 'permission/requested',
      requestId: 'permission-wire-1',
      request: expect.objectContaining({ sessionId: 'session-1' }),
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: 'elicitation/requested',
      requestId: 'elicitation-wire-1',
      request: expect.objectContaining({ mode: 'url' }),
    });

    channel.respondToPermission('permission-wire-1', {
      outcome: 'selected',
      optionId: 'allow',
    });
    channel.respondToElicitation('elicitation-wire-1', {
      action: 'accept',
    });
    await waitForSent(socket, 4);

    expect(socket.sent).toContainEqual({
      jsonrpc: '2.0',
      id: 'permission-wire-1',
      result: { outcome: { outcome: 'selected', optionId: 'allow' } },
    });
    expect(socket.sent).toContainEqual({
      jsonrpc: '2.0',
      id: 'elicitation-wire-1',
      result: { action: 'accept' },
    });

    channel.close();
  });
});
