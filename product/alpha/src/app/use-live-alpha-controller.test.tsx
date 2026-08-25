import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DirectHostClient, HostSnapshot } from '@/portal-client';
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
  threads: [],
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
});
