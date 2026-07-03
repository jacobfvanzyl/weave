import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceFileBackend } from '../../packages/client/src/lib/workspace-file-backend';
import type { EditorTarget, EditorWatchEvent } from '../../packages/client/src/lib/editor-types';

const target: EditorTarget = {
  projectId: 'project-1',
  workspaceId: 'workspace-1',
  portalId: 'portal-1',
  workspacePath: '/workspace',
};

const watchEvent: EditorWatchEvent = {
  kind: 'create',
  paths: ['src/new.ts'],
  affectedDirectories: ['src'],
};

const originalWindow = (globalThis as any).window;
const originalFetch = (globalThis as any).fetch;
const originalWebSocket = (globalThis as any).WebSocket;

const coreDesktopBridge = {
  workspaceFileList: vi.fn(),
  workspaceFileRead: vi.fn(),
  workspaceFileHash: vi.fn(),
  workspaceFileDiffPreview: vi.fn(),
  workspaceFileWrite: vi.fn(),
  workspaceFileMkdir: vi.fn(),
  workspaceFileMove: vi.fn(),
  workspaceFileDelete: vi.fn(),
  workspaceFileIndex: vi.fn(),
  workspaceFileUpload: vi.fn(),
};

describe('workspace file backend watch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as any).window = originalWindow;
    if (originalFetch === undefined) delete (globalThis as { fetch?: unknown }).fetch;
    else (globalThis as any).fetch = originalFetch;
    if (originalWebSocket === undefined) delete (globalThis as { WebSocket?: unknown }).WebSocket;
    else (globalThis as any).WebSocket = originalWebSocket;
  });

  it('uses the desktop bridge watch API when available', async () => {
    let bridgeListener: ((event: { subscriptionId: string; event?: EditorWatchEvent; error?: string }) => void) | undefined;
    const unsubscribe = vi.fn();
    const bridge = {
      ...coreDesktopBridge,
      workspaceFileWatchStart: vi.fn(async () => ({ subscriptionId: 'sub-1', paths: [''] })),
      workspaceFileWatchUpdate: vi.fn(async () => ({ subscriptionId: 'sub-1', paths: ['src'] })),
      workspaceFileWatchStop: vi.fn(async () => undefined),
      onWorkspaceFileWatchEvent: vi.fn(listener => {
        bridgeListener = listener;
        return unsubscribe;
      }),
    };
    (globalThis as any).window = { weaveDesktop: bridge };

    const events: EditorWatchEvent[] = [];
    const backend = createWorkspaceFileBackend({ preferDesktopBridge: true });
    const subscription = await backend.watch!(target, [''], event => events.push(event));

    bridgeListener?.({ subscriptionId: 'other', event: watchEvent });
    bridgeListener?.({ subscriptionId: 'sub-1', event: watchEvent });
    expect(events).toEqual([watchEvent]);

    await subscription.update(['src']);
    subscription.close();
    expect(bridge.workspaceFileWatchStart).toHaveBeenCalledWith(target, ['']);
    expect(bridge.workspaceFileWatchUpdate).toHaveBeenCalledWith('sub-1', ['src']);
    expect(bridge.workspaceFileWatchStop).toHaveBeenCalledWith('sub-1');
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('uses the web token websocket path when no desktop bridge exists', async () => {
    const sockets: FakeWebSocket[] = [];
    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 3;
      readyState = FakeWebSocket.CONNECTING;
      sent: unknown[] = [];
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onerror?: () => void;
      onclose?: () => void;

      constructor(readonly url: string) {
        sockets.push(this);
        queueMicrotask(() => {
          this.readyState = FakeWebSocket.OPEN;
          this.onopen?.();
        });
      }

      send(data: string) {
        const message = JSON.parse(data) as { type: string; requestId?: string; paths?: string[] };
        this.sent.push(message);
        if (message.requestId) {
          queueMicrotask(() => {
            this.onmessage?.({
              data: JSON.stringify({ type: 'workspace-file.watch.ready', requestId: message.requestId, paths: message.paths ?? [] }),
            });
          });
        }
      }

      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.();
      }
    }

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ token: 'watch-token', wsUrl: 'ws://127.0.0.1:4112/workspace-files/watch/connect' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    (globalThis as any).fetch = fetchMock;
    (globalThis as any).WebSocket = FakeWebSocket;
    (globalThis as any).window = {
      fetch: fetchMock,
      WebSocket: FakeWebSocket,
      location: { href: 'http://localhost:4111' },
    };

    const events: EditorWatchEvent[] = [];
    const backend = createWorkspaceFileBackend();
    const subscription = await backend.watch!(target, [''], event => events.push(event));
    expect(String(sockets[0].url)).toBe('ws://127.0.0.1:4112/workspace-files/watch/connect?token=watch-token');
    expect(sockets[0].sent[0]).toEqual({ type: 'watch.start', paths: [''], requestId: 'workspace-file-watch-1' });

    sockets[0].onmessage?.({ data: JSON.stringify({ type: 'workspace-file.watch.change', event: watchEvent }) });
    expect(events).toEqual([watchEvent]);

    await subscription.update(['src']);
    expect(sockets[0].sent[1]).toEqual({ type: 'watch.update', paths: ['src'], requestId: 'workspace-file-watch-2' });
    subscription.close();
    expect(sockets[0].sent[2]).toEqual({ type: 'watch.stop' });
  });
});
