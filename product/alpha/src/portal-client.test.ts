import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlphaBrowserSession, AlphaBrowserState } from './app/alpha-browser-session';
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
  it('revokes visible browser consent when provider attachment fails', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    let snapshot: AlphaBrowserState = {
      supported: true,
      tabs: [{
        id: 'tab-1',
        url: 'https://example.com',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        generation: 1,
        controlRevision: 0,
      }],
      selectedTabId: 'tab-1',
      url: 'https://example.com',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      tabId: 'tab-1',
      generation: 1,
      controlRevision: 0,
      agentControlEnabled: true,
      agentAccess: 'control',
      controlTarget: { threadId: 'thread-1', title: 'Acceptance', controller: 'Codex' },
      visible: true,
    };
    const setAgentAccess = vi.fn((access: AlphaBrowserState['agentAccess']) => {
      snapshot = {
        ...snapshot,
        agentControlEnabled: access !== 'off',
        agentAccess: access,
      };
    });
    const browserSession: AlphaBrowserSession = {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      send: () => true,
      execute: vi.fn(),
      setVisible: vi.fn(),
      setAgentControlEnabled: vi.fn(),
      setAgentAccess,
      setControlTarget: vi.fn(),
    };
    const client = new DirectHostClient(
      '127.0.0.1',
      credential,
      vi.fn(),
      undefined,
      browserSession,
    );
    const internal = client as unknown as {
      activeThread: { threadId: string };
      request: () => Promise<never>;
      queueBrowserSync(): void;
      browserSync: Promise<void>;
    };
    internal.activeThread = { threadId: 'thread-1' };
    internal.request = vi.fn().mockRejectedValue(new Error('Provider unavailable'));

    internal.queueBrowserSync();
    await internal.browserSync;

    expect(setAgentAccess).toHaveBeenCalledWith('off');
    expect(snapshot).toMatchObject({ agentControlEnabled: false, agentAccess: 'off' });
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

  it('buffers Terminal notifications that race the attach snapshot and applies later sequences once', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const onTerminalEvent = vi.fn();
    const client = new DirectHostClient('127.0.0.1', credential, vi.fn());
    const socket = FakeWebSocket.instance;
    const attached = client.attachTerminal(
      'weave',
      'terminal-1',
      'control',
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
      params: { workspaceId: 'weave', terminalId: 'terminal-1', mode: 'control' },
    });

    socket.receive({
      jsonrpc: '2.0',
      method: 'terminal.event',
      params: {
        attachmentId: 'attachment-1',
        workspaceId: 'weave',
        terminalId: 'terminal-1',
        generation: 'generation-1',
        sequence: 5,
        event: { type: 'output', data: 'after snapshot' },
      },
    });
    socket.receive({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        attachment: { attachmentId: 'attachment-1', mode: 'control' },
        snapshot: {
          terminal: {
            terminalId: 'terminal-1',
            workspaceId: 'weave',
            title: 'zsh',
            status: 'running',
            cols: 80,
            rows: 24,
          },
          generation: 'generation-1',
          cursor: 4,
          retainedFrom: 1,
          data: 'snapshot',
          controller: { controlled: true, attachmentId: 'attachment-1' },
        },
      },
    });
    const result = await attached;
    expect(result).toMatchObject({
      attachment: { attachmentId: 'attachment-1' },
      snapshot: { cursor: 4, data: 'snapshot' },
    });
    expect(onTerminalEvent).not.toHaveBeenCalled();
    result.startEvents();
    expect(onTerminalEvent).toHaveBeenCalledTimes(1);
    expect(onTerminalEvent).toHaveBeenCalledWith(expect.objectContaining({
      sequence: 5,
      event: { type: 'output', data: 'after snapshot' },
    }));

    socket.receive({
      jsonrpc: '2.0',
      method: 'terminal.event',
      params: {
        attachmentId: 'attachment-1',
        workspaceId: 'weave',
        terminalId: 'terminal-1',
        generation: 'generation-1',
        sequence: 4,
        event: { type: 'output', data: 'duplicate' },
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
    const attached = client.attachTerminal('weave', 'terminal-1', 'control', onTerminalEvent);
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
          workspaceId: 'weave',
          terminalId: 'terminal-1',
          generation: 'generation-1',
          sequence,
          event: { type: 'output', data: 'x' },
        },
      });
    }
    socket.receive({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        attachment: { attachmentId: 'attachment-1', mode: 'control' },
        snapshot: {
          terminal: {
            terminalId: 'terminal-1',
            workspaceId: 'weave',
            title: 'zsh',
            status: 'running',
            cols: 80,
            rows: 24,
          },
          generation: 'generation-1',
          cursor: 0,
          retainedFrom: 1,
          data: '',
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

  it('preserves typed Terminal control errors', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const client = new DirectHostClient('127.0.0.1', credential, vi.fn());
    const socket = FakeWebSocket.instance;
    const attaching = client.attachTerminal('weave', 'terminal-1', 'control', vi.fn());
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
        message: 'Terminal is controlled by another attachment.',
        data: {
          domain: 'terminal',
          code: 'TERMINAL_CONTROLLED',
          workspaceId: 'weave',
          terminalId: 'terminal-1',
        },
      },
    });
    await expect(attaching).rejects.toMatchObject({
      code: -32012,
      data: { domain: 'terminal', code: 'TERMINAL_CONTROLLED' },
    });
    client.close();
  });
});
