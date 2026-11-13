import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useNetworkChange } from './use-network-change';

describe('useNetworkChange', () => {
  it('runs when the network comes back, not when it goes', () => {
    const onChange = vi.fn();
    const { unmount } = renderHook(() => useNetworkChange(onChange));

    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(onChange).not.toHaveBeenCalled();
    act(() => { window.dispatchEvent(new Event('online')); });
    expect(onChange).toHaveBeenCalledOnce();

    unmount();
    act(() => { window.dispatchEvent(new Event('online')); });
    expect(onChange).toHaveBeenCalledOnce();
  });
});
