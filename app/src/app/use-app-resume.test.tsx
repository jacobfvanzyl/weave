import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppResume } from './use-app-resume';

const show = (state: DocumentVisibilityState) => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
  document.dispatchEvent(new Event('visibilitychange'));
};

afterEach(() => vi.restoreAllMocks());

describe('useAppResume', () => {
  it('runs only after the app returns from having been hidden', () => {
    const onResume = vi.fn();
    const { unmount } = renderHook(() => useAppResume(onResume));

    act(() => show('visible'));
    expect(onResume).not.toHaveBeenCalled();
    act(() => show('hidden'));
    act(() => show('visible'));
    expect(onResume).toHaveBeenCalledOnce();

    unmount();
    act(() => show('hidden'));
    act(() => show('visible'));
    expect(onResume).toHaveBeenCalledOnce();
  });
});
