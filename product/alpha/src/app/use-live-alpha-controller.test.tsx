import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PortalRpcError, type DirectHostClient, type HostSnapshot } from '@/portal-client';
import { useLiveAlphaController } from './use-live-alpha-controller';

vi.mock('./portal-connection-storage', () => ({
  DEFAULT_PORTAL_URL: 'ws://127.0.0.1:4122',
  loadPortalConnection: vi.fn(async () => undefined),
  savePortalConnection: vi.fn(async () => undefined),
}));

const snapshot: HostSnapshot = {
  capabilities: [],
  workspaces: [{ workspaceId: 'weave', name: 'Weave' }],
  agents: [{ agentId: 'codex', name: 'Codex' }],
  threads: [{
    threadId: 'thread-1',
    agentId: 'codex',
    workspaceId: 'weave',
    acpSessionId: 'session-1',
    title: 'Acceptance',
    status: 'active',
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
  }],
};

afterEach(() => {
  vi.useRealTimers();
});

describe('useLiveAlphaController', () => {
  it('silently refreshes a connected Portal and demotes stale state when the transport closes', async () => {
    vi.useFakeTimers();
    let connectionClosed: ((error: Error) => void) | undefined;
    const client = {
      snapshot: vi.fn(async () => snapshot),
      attach: vi.fn(async () => snapshot.threads[0]),
      close: vi.fn(),
    } as unknown as DirectHostClient;
    const createClient = vi.fn((
      _hostUrl: string,
      _token: string,
      _onEvent: ConstructorParameters<typeof DirectHostClient>[2],
      onClose: (error: Error) => void,
    ) => {
      connectionClosed = onClose;
      return client;
    });
    const { result } = renderHook(() => useLiveAlphaController(createClient));

    act(() => result.current.actions.setAccessToken('test-token'));
    await act(async () => result.current.actions.connect());
    expect(result.current.model.connection.status).toBe('connected');
    expect(client.snapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(client.snapshot).toHaveBeenCalledTimes(2);
    expect(result.current.model.busy).toBe(false);

    vi.mocked(client.snapshot).mockRejectedValueOnce(new Error('Temporary refresh failure.'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current.model.error).toBe('Temporary refresh failure.');

    vi.mocked(client.snapshot).mockResolvedValueOnce(snapshot);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current.model.error).toBeUndefined();

    act(() => connectionClosed?.(new Error('Portal connection closed.')));
    expect(result.current.model.connection.status).toBe('disconnected');
    expect(result.current.model.error).toBe('Portal connection closed.');
  });

  it('browses and reads Workspace files through the connected Portal', async () => {
    let onWatchEvent: ((event: { kind: 'modify'; paths: string[]; affectedDirectories: string[] }) => void) | undefined;
    const watch = { update: vi.fn(async (paths: string[]) => paths), close: vi.fn(async () => undefined) };
    const client = {
      snapshot: vi.fn(async () => snapshot),
      attach: vi.fn(async () => snapshot.threads[0]),
      listWorkspaceFiles: vi.fn(async (_workspaceId: string, path: string) => ({
        path,
        entries: path === ''
          ? [{ name: 'src', path: 'src', type: 'directory' as const }, {
            name: 'README.md',
            path: 'README.md',
            type: 'file' as const,
          }]
          : [{ name: 'main.ts', path: 'src/main.ts', type: 'file' as const }],
        truncated: false,
      })),
      readWorkspaceFile: vi.fn(async (_workspaceId: string, path: string) => ({
        path,
        content: path === 'src/main.ts' ? 'export {};\n' : '# Weave\n',
        contentHash: '0'.repeat(64),
        size: 11,
      })),
      watchWorkspaceFiles: vi.fn(async (
        _workspaceId: string,
        paths: string[],
        listener: typeof onWatchEvent,
      ) => {
        onWatchEvent = listener;
        return { subscriptionId: 'watch-1', paths, ...watch };
      }),
      close: vi.fn(),
    } as unknown as DirectHostClient;
    const createClient = vi.fn(() => client);
    const { result } = renderHook(() => useLiveAlphaController(createClient));

    act(() => result.current.actions.setAccessToken('test-token'));
    await act(async () => result.current.actions.connect());
    await act(async () => result.current.actions.selectThread('thread-1'));
    expect(result.current.model.workspaceFiles).toMatchObject({
      workspaceId: 'weave',
      workspaceName: 'Weave',
      directories: {
        '': { entries: [{ path: 'src' }, { path: 'README.md' }] },
      },
    });
    expect(client.watchWorkspaceFiles).toHaveBeenCalledWith('weave', [''], expect.any(Function));

    await act(async () => result.current.actions.openWorkspaceDirectory('src'));
    expect(result.current.model.workspaceFiles?.directories.src?.entries).toEqual([{
      name: 'main.ts',
      path: 'src/main.ts',
      type: 'file',
    }]);
    expect(result.current.model.workspaceFiles?.directories['']?.entries).toHaveLength(2);
    expect(watch.update).not.toHaveBeenCalled();
    await act(async () => result.current.actions.openWorkspaceDirectory('src'));
    expect(client.listWorkspaceFiles).toHaveBeenCalledTimes(2);
    await act(async () => result.current.actions.openWorkspaceFile('src/main.ts'));
    expect(result.current.model.workspaceFiles?.openFiles[0]).toMatchObject({
      kind: 'text',
      path: 'src/main.ts',
      content: 'export {};\n',
    });
    await act(async () => result.current.actions.openWorkspaceFile('README.md'));
    expect(result.current.model.workspaceFiles?.openFiles.map((file) => file.path)).toEqual([
      'src/main.ts',
      'README.md',
    ]);
    expect(result.current.model.workspaceFiles?.activeFilePath).toBe('README.md');
    act(() => result.current.actions.activateWorkspaceFile('src/main.ts'));
    expect(result.current.model.workspaceFiles?.activeFilePath).toBe('src/main.ts');
    await act(async () => result.current.actions.openWorkspaceFile('README.md'));
    expect(client.readWorkspaceFile).toHaveBeenCalledTimes(2);
    act(() => result.current.actions.closeWorkspaceFile('README.md'));
    expect(result.current.model.workspaceFiles?.activeFilePath).toBe('src/main.ts');

    await act(async () => {
      onWatchEvent?.({ kind: 'modify', paths: ['src/main.ts'], affectedDirectories: ['src'] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.model.workspaceFiles?.openFiles[0]).toMatchObject({
      kind: 'text',
      path: 'src/main.ts',
      content: 'export {};\n',
      changed: true,
    });

    await act(async () => result.current.actions.reloadWorkspaceFile());
    expect(result.current.model.workspaceFiles?.openFiles[0]).toMatchObject({ changed: false });
    expect(result.current.model.selectedThreadId).toBe('thread-1');
  });

  it('turns binary and oversized read errors into preview-unavailable state', async () => {
    const client = {
      snapshot: vi.fn(async () => snapshot),
      attach: vi.fn(async () => snapshot.threads[0]),
      listWorkspaceFiles: vi.fn(async () => ({ path: '', entries: [], truncated: false })),
      readWorkspaceFile: vi.fn(async () => {
        throw new PortalRpcError(-32010, 'Only UTF-8 text files are supported.', {
          domain: 'workspace-filesystem',
          code: 'UNSUPPORTED_CONTENT',
          path: 'image.bin',
        });
      }),
      watchWorkspaceFiles: vi.fn(async (_workspaceId: string, paths: string[]) => ({
        subscriptionId: 'watch-1',
        paths,
        update: vi.fn(async (nextPaths: string[]) => nextPaths),
        close: vi.fn(async () => undefined),
      })),
      close: vi.fn(),
    } as unknown as DirectHostClient;
    const { result } = renderHook(() => useLiveAlphaController(vi.fn(() => client)));

    act(() => result.current.actions.setAccessToken('test-token'));
    await act(async () => result.current.actions.connect());
    await act(async () => result.current.actions.selectThread('thread-1'));
    await act(async () => result.current.actions.openWorkspaceFile('image.bin'));

    expect(result.current.model.workspaceFiles?.openFiles).toEqual([{
      kind: 'unavailable',
      path: 'image.bin',
      reason: 'unsupported',
    }]);
    expect(result.current.model.workspaceFiles?.activeFilePath).toBe('image.bin');
    expect(result.current.model.error).toBeUndefined();
  });
});
