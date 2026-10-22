import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus } from '@capacitor/network';
import { useNetworkChange } from './use-network-change';

const network = vi.hoisted(() => ({
  listener: undefined as ((status: ConnectionStatus) => void) | undefined,
  status: { connected: true, connectionType: 'wifi' } as ConnectionStatus,
  remove: vi.fn(async () => undefined),
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    getStatus: vi.fn(async () => network.status),
    addListener: vi.fn(async (_event: string, listener: (status: ConnectionStatus) => void) => {
      network.listener = listener;
      return { remove: network.remove };
    }),
  },
}));

beforeEach(() => {
  network.listener = undefined;
  network.remove.mockClear();
});

describe('useNetworkChange', () => {
  it('runs when the network comes back or changes, not when it goes or stays the same', async () => {
    const onChange = vi.fn();
    const { unmount } = renderHook(() => useNetworkChange(onChange));
    await act(async () => await Promise.resolve());

    act(() => network.listener?.({ connected: true, connectionType: 'wifi' }));
    expect(onChange).not.toHaveBeenCalled();
    act(() => network.listener?.({ connected: true, connectionType: 'cellular' }));
    expect(onChange).toHaveBeenCalledOnce();
    act(() => network.listener?.({ connected: false, connectionType: 'none' }));
    expect(onChange).toHaveBeenCalledOnce();
    act(() => network.listener?.({ connected: true, connectionType: 'cellular' }));
    expect(onChange).toHaveBeenCalledTimes(2);

    unmount();
    await expect.poll(() => network.remove).toHaveBeenCalledOnce();
  });
});
