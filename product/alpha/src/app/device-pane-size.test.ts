import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useDevicePaneSize } from './device-pane-size';

beforeEach(() => window.localStorage.clear());

it('restores each device pane preference across remounts without mixing width and height', () => {
  const first = renderHook(() => useDevicePaneSize('agent-width', 35));
  act(() => first.result.current[1](42));
  first.unmount();
  expect(renderHook(() => useDevicePaneSize('agent-width', 35)).result.current[0]).toBe(42);
  expect(renderHook(() => useDevicePaneSize('agent-height', 35)).result.current[0]).toBe(35);
  expect(renderHook(() => useDevicePaneSize('sidebar-width')).result.current[0]).toBeUndefined();
});

it('ignores invalid stored sizes and keeps resizing functional when storage fails', () => {
  window.localStorage.setItem('pane', '{broken');
  const pane = renderHook(() => useDevicePaneSize('pane', 35));
  expect(pane.result.current[0]).toBe(35);
  act(() => { pane.result.current[1](100); pane.result.current[1](Number.NaN); });
  expect(pane.result.current[0]).toBe(35);
  const write = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
  act(() => pane.result.current[1](45));
  expect(pane.result.current[0]).toBe(45);
  write.mockRestore();
});
