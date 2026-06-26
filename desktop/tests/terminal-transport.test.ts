import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureMastraConnection } from '../../packages/client/src/lib/mastra-client';
import { createWebTerminalTransport } from '../../packages/client/src/lib/terminal-transport';
import type { TerminalTargetInput } from '../../packages/client/src/lib/terminal-types';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;

  readonly sent: string[] = [];
  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.onmessage?.({ data: JSON.stringify({ type: 'terminal.accepted' }) });
    });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('terminal transport', () => {
  afterEach(() => {
    FakeWebSocket.instances = [];
    configureMastraConnection({ mastraUrl: 'http://localhost:4111', authToken: null });
    vi.unstubAllGlobals();
  });

  it('routes close through the target connection when no terminal session connection exists', async () => {
    configureMastraConnection({ mastraUrl: 'http://weave.test', authToken: 'token-1' });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ token: 'terminal-token', wsUrl: 'ws://weave.test/terminals/connect' }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('window', {
      fetch: fetchMock,
      WebSocket: FakeWebSocket,
    });

    const target: TerminalTargetInput = {
      kind: 'workspace',
      terminalId: 'terminal-1',
      portalId: 'portal-1',
      rootId: 'root-1',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      workspacePath: '/repo/workspace',
    };

    const transport = createWebTerminalTransport();
    await transport?.close('terminal-1', target);

    expect(fetchMock).toHaveBeenCalledWith('http://weave.test/code/terminals/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer token-1' },
      body: JSON.stringify(target),
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(new URL(FakeWebSocket.instances[0].url).searchParams.get('token')).toBe('terminal-token');
    expect(FakeWebSocket.instances[0].sent.map(message => JSON.parse(message))).toEqual([
      { type: 'close', terminalId: 'terminal-1' },
    ]);
  });

  it('does not open a web terminal connection for an unscoped close', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ token: 'terminal-token', wsUrl: 'ws://weave.test/terminals/connect' }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('window', {
      fetch: fetchMock,
      WebSocket: FakeWebSocket,
    });

    const transport = createWebTerminalTransport();
    await transport?.close('terminal-1');

    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
