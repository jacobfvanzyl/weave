import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PortalRpcError, type DirectHostClient, type HostSnapshot } from '@/portal-client';
import { useLiveAlphaController } from './use-live-alpha-controller';

vi.mock('./portal-connection-storage', () => ({
  loadPortalConnections: vi.fn(async () => ({
    connections: [{
      hostId: 'host-1',
      displayName: 'Bazzite',
      hostUrl: 'wss://bazzite.test:4122',
      credentialId: 'credential-1',
      keyId: 'key-1',
    }],
    selectedHostId: 'host-1',
  })),
  savePortalConnections: vi.fn(async () => undefined),
}));

const snapshot: HostSnapshot = {
  hostId: 'host-1',
  displayName: 'Bazzite',
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
  it('reports prompt failures and rejects so the composer can restore its draft', async () => {
    let onEvent: ConstructorParameters<typeof DirectHostClient>[2] | undefined;
    const client = {
      snapshot: vi.fn(async () => snapshot),
      prompt: vi.fn(async () => {
        throw new Error('Portal unavailable.');
      }),
      close: vi.fn(),
    } as unknown as DirectHostClient;
    const createClient = vi.fn((
      _hostUrl: string,
      _credential: unknown,
      nextOnEvent: ConstructorParameters<typeof DirectHostClient>[2],
    ) => {
      onEvent = nextOnEvent;
      return client;
    });
    const { result } = renderHook(() => useLiveAlphaController(createClient));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => onEvent?.({ type: 'history/reset', sessionId: 'session-1' }));

    await act(async () => {
      await expect(result.current.actions.sendPrompt('Keep my draft'))
        .rejects.toThrow('Portal unavailable.');
    });

    expect(result.current.model.error).toBe('Portal unavailable.');
    expect(client.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'Keep my draft' }]);
  });

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
      _credential: unknown,
      _onEvent: ConstructorParameters<typeof DirectHostClient>[2],
      onClose: (error: Error) => void,
    ) => {
      connectionClosed = onClose;
      return client;
    });
    const { result } = renderHook(() => useLiveAlphaController(createClient));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
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

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => result.current.actions.selectThread('host-1:thread-1'));
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
    expect(result.current.model.selectedThreadId).toBe('host-1:thread-1');
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

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => result.current.actions.selectThread('host-1:thread-1'));
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
