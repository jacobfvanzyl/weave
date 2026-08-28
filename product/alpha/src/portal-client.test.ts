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
  onmessage?: (event: { data: string }) => void;
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
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('DirectHostClient', () => {
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
        protocolVersion: 2,
        hostId: 'host-1',
        displayName: 'Old Portal',
        principal: { principalId: 'principal-1', credentialId: 'credential-1', label: 'Test' },
        capabilities: ['workspace.list', 'agent.list', 'thread.list', 'thread.attach'],
      },
    });
    for (let attempt = 0; attempt < 20 && socket.sent.length < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const requests = socket.sent.slice(2).map((value) => JSON.parse(value));
    expect(requests.filter(({ method }) => method === 'thread.list')).toHaveLength(1);
    for (const request of requests) {
      const result = request.method === 'workspace.list'
        ? { workspaces: [{ workspaceId: 'weave', name: 'Weave' }] }
        : request.method === 'agent.list'
        ? { agents: [{ agentId: 'codex', name: 'Codex' }] }
        : {
          threads: [{
            threadId: 'thread-1',
            agentId: 'codex',
            workspaceId: 'weave',
            acpSessionId: 'session-1',
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
    expect(request).toMatchObject({ method: 'workspace.file.list', params: { workspaceId: 'weave', path: '' } });
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
});
