import { decodeHostMessage, encodeHostMessage, TERMINAL_CODEC } from '@weave/product-protocol';
const bytes = (text: string) => new TextEncoder().encode(text);
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectHostClient, PortalTransportError } from './portal-client';

const credential = {
  hostId: 'host-1',
  credentialId: 'credential-1',
  sign: vi.fn(async () => 'signature'),
};

class FakeWebSocket {
  static instance: FakeWebSocket;

  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string | Uint8Array }) => void;
  onclose?: (event: { code: number; reason: string }) => void;
  sent: string[] = [];

  constructor() {
    FakeWebSocket.instance = this;
  }

  send(value: string) {
    this.sent.push(value);
  }

  close(code = 1000, reason = '') {
    this.onclose?.({ code, reason });
  }

  open() {
    this.onopen?.();
  }

  receive(value: unknown) {
    this.onmessage?.({ data: encodeHostMessage(value) });
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('DirectHostClient', () => {
  it('rejects terminal cleanup after a socket closes instead of hanging the replacement attachment', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const client = new DirectHostClient('127.0.0.1', credential, vi.fn());
    const socket = FakeWebSocket.instance;
    socket.receive({ type: 'weave.portal.auth.authenticated', principal: { principalId: 'principal-1', credentialId: 'credential-1', label: 'Test' } });
    socket.close(1006, 'Connection lost');
    const result = await Promise.race([
      client.detachTerminal('context', 'terminal', 'attachment').catch((error) => error),
      new Promise((resolve) => setTimeout(() => resolve('request hung'), 100)),
    ]);
    expect(result).toBeInstanceOf(PortalTransportError);
    expect(socket.sent).toHaveLength(0);
    client.close();
  });

  it('releases pending and later requests on explicit close without waiting for the browser close event', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const client = new DirectHostClient('127.0.0.1', credential, vi.fn());
    const socket = FakeWebSocket.instance;
    socket.receive({ type: 'weave.portal.auth.authenticated', principal: { principalId: 'principal-1', credentialId: 'credential-1', label: 'Test' } });
    const pending = client.listTerminals('context');
    const rejected = expect(pending).rejects.toBeInstanceOf(PortalTransportError);
    await Promise.resolve();
    const sent = socket.sent.length;
    socket.close = () => {};
    client.close();
    await rejected;
    await expect(client.detachTerminal('context', 'terminal', 'attachment')).rejects.toBeInstanceOf(PortalTransportError);
    expect(socket.sent).toHaveLength(sent);
  });

  it('rejects requests waiting for authentication when the connection closes', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const client = new DirectHostClient('127.0.0.1', credential, vi.fn());
    const pending = client.listTerminals('context');
    const rejected = expect(pending).rejects.toBeInstanceOf(PortalTransportError);
    FakeWebSocket.instance.close(1006, 'Connection lost before authentication');
    await rejected;
    client.close();
  });

  it('does not reinterpret active Threads from a pre-lifecycle Portal as archived', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const client = new DirectHostClient('127.0.0.1', credential, vi.fn());
    const socket = FakeWebSocket.instance;
    const snapshot = client.snapshot();
    socket.receive({
      type: 'weave.portal.auth.challenge',
      challengeId: 'challenge-1',
      hostId: 'host-1',
      nonce: 'nonce',
      audience: '/rpc',
      origin: '-',
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
    });
    for (let attempt = 0; attempt < 20 && socket.sent.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    socket.receive({
      type: 'weave.portal.auth.authenticated',
      principal: { principalId: 'principal-1', credentialId: 'credential-1', label: 'Test' },
    });
    for (let attempt = 0; attempt < 20 && socket.sent.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const capabilitiesRequest = JSON.parse(socket.sent[1]);
    socket.receive({
      jsonrpc: '2.0',
      id: capabilitiesRequest.id,
      result: {
        protocolVersion: 6,
        hostId: 'host-1',
        displayName: 'Old Portal',
        principal: { principalId: 'principal-1', credentialId: 'credential-1', label: 'Test' },
        capabilities: ['context.list', 'agent.list', 'thread.list', 'thread.attach'],
      },
    });
    for (let attempt = 0; attempt < 20 && socket.sent.length < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const requests = socket.sent.slice(2).map((value) => JSON.parse(value));
    expect(requests.filter(({ method }) => method === 'thread.list')).toHaveLength(1);
    for (const request of requests) {
      const result = request.method === 'context.list'
        ? { executionContexts: [{ executionContextId: 'weave', name: 'Weave' }] }
        : request.method === 'agent.list'
        ? { agents: [{ agentId: 'codex', name: 'Codex' }] }
        : {
          threads: [{
            threadId: 'thread-1',
            agentId: 'codex',
            executionContextId: 'weave',
            workspaceId: 'workspace', membershipRevision: 0, acpSessionId: 'session-1',
            status: 'active',
            createdAt: '2026-08-26T00:00:00.000Z',
            updatedAt: '2026-08-26T00:00:00.000Z',
          }],
        };
      socket.receive({ jsonrpc: '2.0', id: request.id, result });
    }

    await expect(snapshot).resolves.toMatchObject({
      threads: [{ threadId: 'thread-1', status: 'active' }],
      archivedThreads: [],
    });
    client.close();
  });

  it('reports an unexpected Portal transport closure without reporting an intentional disconnect', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const onClose = vi.fn();
    const first = new DirectHostClient('127.0.0.1', credential, vi.fn(), onClose);

    FakeWebSocket.instance.onclose?.({ code: 1006, reason: 'Portal stopped' });
    expect(onClose).toHaveBeenCalledWith(expect.any(PortalTransportError));
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Portal stopped',
      closeCode: 1006,
    }));

    onClose.mockClear();
    const second = new DirectHostClient('127.0.0.1', credential, vi.fn(), onClose);
    second.close();
    expect(onClose).not.toHaveBeenCalled();
    first.close();
  });

  it('parses Workspace file results and preserves typed Portal errors', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const client = new DirectHostClient('127.0.0.1', credential, vi.fn());
    const socket = FakeWebSocket.instance;
    const list = client.listWorkspaceFiles('weave', '');
    socket.receive({
      type: 'weave.portal.auth.challenge',
      challengeId: 'challenge-1',
      hostId: 'host-1',
      nonce: 'nonce',
      audience: '/rpc',
      origin: '-',
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
    });
    await Promise.resolve();
    await Promise.resolve();
    socket.receive({
      type: 'weave.portal.auth.authenticated',
      principal: { principalId: 'principal-1', credentialId: 'credential-1', label: 'Test' },
    });
    await Promise.resolve();
    const request = JSON.parse(socket.sent[1]);
    expect(request).toMatchObject({ method: 'context.file.list', params: { executionContextId: 'weave', path: '' } });
    socket.receive({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        path: '',
        entries: [{ name: 'README.md', path: 'README.md', type: 'file', size: 8 }],
        truncated: false,
      },
    });
    await expect(list).resolves.toMatchObject({ entries: [{ path: 'README.md' }] });

    const write = client.writeWorkspaceFile('weave', 'README.md', 'stale', '0'.repeat(64));
    await Promise.resolve();
    const writeRequest = JSON.parse(socket.sent[2]);
    socket.receive({
      jsonrpc: '2.0',
      id: writeRequest.id,
      error: {
        code: -32010,
        message: 'File changed on disk. Reload before saving.',
        data: { domain: 'workspace-filesystem', code: 'STALE_CONTENT', path: 'README.md' },
      },
    });
    await expect(write).rejects.toMatchObject({
      code: -32010,
      data: { domain: 'workspace-filesystem', code: 'STALE_CONTENT', path: 'README.md' },
    });
    client.close();
  });

  it('buffers Terminal notifications that race the attach snapshot and applies later sequences once', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const onTerminalEvent = vi.fn();
    const client = new DirectHostClient('127.0.0.1', credential, vi.fn());
    const socket = FakeWebSocket.instance;
    const attached = client.attachTerminal(
      'weave',
      'terminal-1',
      'shared',
      onTerminalEvent,
    );
    socket.receive({
      type: 'weave.portal.auth.challenge',
      challengeId: 'challenge-1',
      hostId: 'host-1',
      nonce: 'nonce',
      audience: '/rpc',
      origin: '-',
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
    });
    await Promise.resolve();
    await Promise.resolve();
    socket.receive({
      type: 'weave.portal.auth.authenticated',
      principal: { principalId: 'principal-1', credentialId: 'credential-1', label: 'Test' },
    });
    await Promise.resolve();
    const request = JSON.parse(socket.sent[1]);
    expect(request).toMatchObject({
      method: 'terminal.attach',
      params: { executionContextId: 'weave', terminalId: 'terminal-1', mode: 'shared' },
    });

    socket.receive({
      jsonrpc: '2.0',
      method: 'terminal.event',
      params: {
        attachmentId: 'attachment-1',
        executionContextId: 'weave',
        terminalId: 'terminal-1',
        generation: 'generation-1',
        sequence: 5,
        event: { type: 'output', data: bytes('after snapshot') },
      },
    });
    socket.receive({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        attachment: { attachmentId: 'attachment-1', mode: 'shared' },
        snapshot: { codec: TERMINAL_CODEC,
          terminal: {
            terminalId: 'terminal-1',
            executionContextId: 'weave',
            title: 'zsh',
            status: 'running',
            cols: 80,
            rows: 24,
          },
          generation: 'generation-1',
          cursor: 4,
          retainedFrom: 1,
          data: bytes('snapshot'),
          controller: { controlled: true, attachmentId: 'attachment-1' },
        },
      },
    });
    const result = await attached;
    expect(result).toMatchObject({
      attachment: { attachmentId: 'attachment-1' },
      snapshot: { codec: TERMINAL_CODEC, cursor: 4, data: bytes('snapshot') },
    });
    expect(onTerminalEvent).not.toHaveBeenCalled();
    result.startEvents();
    expect(onTerminalEvent).toHaveBeenCalledTimes(1);
    expect(onTerminalEvent).toHaveBeenCalledWith(expect.objectContaining({
      sequence: 5,
      event: { type: 'output', data: bytes('after snapshot') },
    }));

    socket.receive({
      jsonrpc: '2.0',
      method: 'terminal.event',
      params: {
        attachmentId: 'attachment-1',
        executionContextId: 'weave',
        terminalId: 'terminal-1',
        generation: 'generation-1',
        sequence: 4,
        event: { type: 'output', data: bytes('duplicate') },
      },
    });
    expect(onTerminalEvent).toHaveBeenCalledTimes(1);
    client.close();
  });

  it('forces a fresh snapshot when attach-time Terminal notifications overflow', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const onTerminalEvent = vi.fn();
    const client = new DirectHostClient('127.0.0.1', credential, vi.fn());
    const socket = FakeWebSocket.instance;
    const attached = client.attachTerminal('weave', 'terminal-1', 'shared', onTerminalEvent);
    socket.receive({
      type: 'weave.portal.auth.challenge',
      challengeId: 'challenge-1',
      hostId: 'host-1',
      nonce: 'nonce',
      audience: '/rpc',
      origin: '-',
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
    });
    await Promise.resolve();
    await Promise.resolve();
    socket.receive({
      type: 'weave.portal.auth.authenticated',
      principal: { principalId: 'principal-1', credentialId: 'credential-1', label: 'Test' },
    });
    await Promise.resolve();
    const request = JSON.parse(socket.sent[1]);
    for (let sequence = 1; sequence <= 257; sequence += 1) {
      socket.receive({
        jsonrpc: '2.0',
        method: 'terminal.event',
        params: {
          attachmentId: 'attachment-1',
          executionContextId: 'weave',
          terminalId: 'terminal-1',
          generation: 'generation-1',
          sequence,
          event: { type: 'output', data: bytes('x') },
        },
      });
    }
    socket.receive({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        attachment: { attachmentId: 'attachment-1', mode: 'shared' },
        snapshot: { codec: TERMINAL_CODEC,
          terminal: {
            terminalId: 'terminal-1',
            executionContextId: 'weave',
            title: 'zsh',
            status: 'running',
            cols: 80,
            rows: 24,
          },
          generation: 'generation-1',
          cursor: 0,
          retainedFrom: 1,
          data: bytes(''),
          controller: { controlled: true, attachmentId: 'attachment-1' },
        },
      },
    });

    const result = await attached;
    result.startEvents();
    expect(onTerminalEvent).toHaveBeenCalledOnce();
    expect(onTerminalEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: { type: 'resync', retainedFrom: 1 },
    }));
    client.close();
  });

  it('preserves typed Terminal write-permission errors', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const client = new DirectHostClient('127.0.0.1', credential, vi.fn());
    const socket = FakeWebSocket.instance;
    const attaching = client.attachTerminal('weave', 'terminal-1', 'shared', vi.fn());
    socket.receive({
      type: 'weave.portal.auth.challenge',
      challengeId: 'challenge-1',
      hostId: 'host-1',
      nonce: 'nonce',
      audience: '/rpc',
      origin: '-',
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
    });
    await Promise.resolve();
    await Promise.resolve();
    socket.receive({
      type: 'weave.portal.auth.authenticated',
      principal: { principalId: 'principal-1', credentialId: 'credential-1', label: 'Test' },
    });
    await Promise.resolve();
    const request = JSON.parse(socket.sent[1]);
    socket.receive({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32012,
        message: 'Terminal attachment is read-only.',
        data: {
          domain: 'terminal',
          code: 'TERMINAL_WRITE_REQUIRED',
          executionContextId: 'weave',
          terminalId: 'terminal-1',
        },
      },
    });
    await expect(attaching).rejects.toMatchObject({
      code: -32012,
      data: { domain: 'terminal', code: 'TERMINAL_WRITE_REQUIRED' },
    });
    client.close();
  });
});


it('sends ordered binary input before earlier acknowledgements and never replays uncertain input', async () => {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  const client = new DirectHostClient('127.0.0.1', credential, vi.fn());
  const socket = FakeWebSocket.instance;
  socket.receive({ type: 'weave.portal.auth.authenticated', principal: { principalId: 'principal-1', credentialId: 'credential-1', label: 'Test' } });
  const first = client.inputTerminal('context', 'terminal', 'attachment', new Uint8Array([27, 91, 77, 255, 128, 160]));
  const second = client.inputTerminal('context', 'terminal', 'attachment', 'second');
  const rejected = expect(second).rejects.toBeInstanceOf(PortalTransportError);
  await Promise.resolve();
  expect(socket.sent).toHaveLength(2); // Neither response has arrived.
  const requests = socket.sent.map(value => decodeHostMessage(value)) as { id: number; params: { data: Uint8Array } }[];
  expect(requests[0].params.data).toEqual(new Uint8Array([27, 91, 77, 255, 128, 160]));
  expect(requests[1].params.data).toEqual(bytes('second'));
  socket.receive({ jsonrpc: '2.0', id: requests[0].id, result: { accepted: true } });
  await first;
  socket.close(1006, 'Connection lost'); await rejected;
  expect(socket.sent).toHaveLength(2);
  client.close();
});

it('fails pending work on malformed binary transport instead of leaving input hanging', async () => {
  vi.stubGlobal('WebSocket', FakeWebSocket);
  const client = new DirectHostClient('127.0.0.1', credential, vi.fn());
  const socket = FakeWebSocket.instance;
  socket.receive({ type: 'weave.portal.auth.authenticated', principal: { principalId: 'principal-1', credentialId: 'credential-1', label: 'Test' } });
  const pending = client.inputTerminal('context', 'terminal', 'attachment', 'input');
  const rejected = expect(pending).rejects.toBeInstanceOf(PortalTransportError);
  await Promise.resolve();
  socket.onmessage?.({ data: new Uint8Array([0, 1, 2]) });
  await rejected;
  client.close();
});
