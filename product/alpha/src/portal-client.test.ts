import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectHostClient } from './portal-client';

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
  it('reports an unexpected Portal transport closure without reporting an intentional disconnect', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const onClose = vi.fn();
    const first = new DirectHostClient('127.0.0.1', 'token', vi.fn(), onClose);

    FakeWebSocket.instance.onclose?.({ code: 1006, reason: 'Portal stopped' });
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ message: 'Portal stopped' }));

    onClose.mockClear();
    const second = new DirectHostClient('127.0.0.1', 'token', vi.fn(), onClose);
    second.close();
    expect(onClose).not.toHaveBeenCalled();
    first.close();
  });

  it('parses Workspace file results and preserves typed Portal errors', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const client = new DirectHostClient('127.0.0.1', 'token', vi.fn());
    const socket = FakeWebSocket.instance;
    const list = client.listWorkspaceFiles('weave', '');
    socket.open();
    await Promise.resolve();
    const request = JSON.parse(socket.sent[0]);
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
    const writeRequest = JSON.parse(socket.sent[1]);
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
