import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { TerminalOutputStream } from '@/terminal/output-stream';
import type { NativeTerminalEvent } from '@/terminal/native-terminal';
import { NativeTerminalView } from './native-terminal-view';
const native = vi.hoisted(() => ({
  focus: vi.fn(), create: vi.fn(), layout: vi.fn(), write: vi.fn(), close: vi.fn(), remove: vi.fn(),
  listener: undefined as ((event: NativeTerminalEvent) => void) | undefined,
}));
vi.mock('@/terminal/native-terminal', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/terminal/native-terminal')>(),
  nativeTerminalBridge: {
    ...native,
    addListener: async (_event: string, listener: (event: NativeTerminalEvent) => void) => {
      native.listener = listener; return { remove: native.remove };
    },
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  native.listener = undefined;
  native.create.mockResolvedValue({ surfaceId: 'native-1', renderer: 'libghostty-vt-coretext' });
  native.layout.mockResolvedValue({ cols: 80, rows: 24 });
  native.write.mockResolvedValue(undefined);
  native.close.mockResolvedValue(undefined);
  native.focus.mockResolvedValue(undefined);
  native.remove.mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
});
it('awaits native snapshot consumption before live output and fences read-only and foreign input', async () => {
  let consume!: () => void;
  native.write.mockImplementationOnce(() => new Promise<void>((resolve) => { consume = resolve; }));
  const output = new TerminalOutputStream(vi.fn());
  output.reset('snapshot 界');
  const input = vi.fn();
  const { rerender, unmount } = render(<NativeTerminalView output={output} readOnly={false} onInput={input} />);
  await waitFor(() => expect(native.write).toHaveBeenCalledOnce());
  output.write('live');
  expect(native.write).toHaveBeenCalledTimes(1);
  await act(async () => consume());
  await waitFor(() => expect(native.write).toHaveBeenCalledTimes(2));
  expect(native.write.mock.calls[1][0]).toEqual({ surfaceId: 'native-1', data: btoa('live'), reset: false });
  act(() => native.listener?.({ surfaceId: 'other', kind: 'input', data: btoa('foreign') }));
  expect(input).not.toHaveBeenCalled();
  act(() => native.listener?.({ surfaceId: 'native-1', kind: 'input', data: btoa('typed') }));
  expect(input).toHaveBeenCalledWith('typed');
  input.mockClear();
  rerender(<NativeTerminalView output={output} readOnly onInput={input} />);
  act(() => native.listener?.({ surfaceId: 'native-1', kind: 'input', data: btoa('readonly') }));
  expect(input).not.toHaveBeenCalled();
  unmount();
  act(() => native.listener?.({ surfaceId: 'native-1', kind: 'input', data: btoa('late') }));
  expect(input).not.toHaveBeenCalled();
  expect(native.close).toHaveBeenCalledWith({ surfaceId: 'native-1' });
  expect(native.remove).toHaveBeenCalledOnce();
});
it('closes a view created after unmount without attaching an output consumer', async () => {
  let created!: (value: { surfaceId: string; renderer: string }) => void;
  native.create.mockImplementationOnce(() => new Promise((resolve) => { created = resolve; }));
  const output = new TerminalOutputStream(vi.fn()); output.reset('pending');
  const { unmount } = render(<NativeTerminalView output={output} readOnly={false} />);
  await waitFor(() => expect(native.create).toHaveBeenCalledOnce());
  unmount();
  await act(async () => created({ surfaceId: 'late-view', renderer: 'libghostty-vt-coretext' }));
  expect(native.close).toHaveBeenCalledWith({ surfaceId: 'late-view' });
  expect(native.write).not.toHaveBeenCalled();
});
it('surfaces native input failure instead of treating the view as usable', async () => {
  const { getByRole } = render(<NativeTerminalView output={new TerminalOutputStream(vi.fn())} readOnly={false} />);
  await waitFor(() => expect(native.layout).toHaveBeenCalled());
  act(() => native.listener?.({ surfaceId: 'native-1', kind: 'error', message: 'Native input queue overflowed.' }));
  expect(getByRole('alert')).toHaveTextContent('Native input queue overflowed.');
});

it('waits for native geometry before replaying a saved screen', async () => {
  let fitted!: (value: { cols: number; rows: number }) => void;
  native.layout.mockImplementationOnce(() => new Promise((resolve) => { fitted = resolve; }));
  const output = new TerminalOutputStream(vi.fn()); output.reset('saved viewport');
  render(<NativeTerminalView output={output} readOnly={false} />);
  await waitFor(() => expect(native.layout).toHaveBeenCalled());
  expect(native.write).not.toHaveBeenCalled();
  await act(async () => fitted({ cols: 120, rows: 40 }));
  await waitFor(() => expect(native.write).toHaveBeenCalledWith({ surfaceId: 'native-1', data: btoa('saved viewport'), reset: true }));
});

it('resizes the Host only for acknowledged visible geometry', async () => {
  const rectangle = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 720, height: 360 } as DOMRect);
  const resize = vi.fn();
  const output = new TerminalOutputStream(vi.fn());
  const content = (overlay = false) => <><NativeTerminalView output={output} readOnly={false} onResize={resize} />{overlay && <div role='dialog'>Workspace actions</div>}</>;
  try {
    const { rerender } = render(content());
    await waitFor(() => expect(resize).toHaveBeenCalledWith(80, 24));
    resize.mockClear();
    act(() => native.listener?.({ surfaceId: 'native-1', kind: 'resize', cols: 2, rows: 2 }));
    expect(resize).not.toHaveBeenCalled();
    rerender(content(true));
    await waitFor(() => expect(native.layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false })));
    expect(resize).not.toHaveBeenCalled();
  } finally { rectangle.mockRestore(); }
});

it('restores requested observer focus after layout, without recreating or resizing the terminal', async () => {
  const rectangle = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 720, height: 360 } as DOMRect);
  const output = new TerminalOutputStream(vi.fn()); const resize = vi.fn(); const input = vi.fn();
  const content = (overlay = false) => <><NativeTerminalView output={output} readOnly focusRequest='pane-1' onResize={resize} onInput={input} />{overlay && <div role='dialog'>Actions</div>}</>;
  try {
    const { rerender } = render(content());
    await waitFor(() => expect(native.focus).toHaveBeenCalledOnce());
    act(() => native.listener?.({ surfaceId: 'native-1', kind: 'focus' }));
    rerender(content(true));
    await waitFor(() => expect(native.layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false })));
    rerender(content());
    await waitFor(() => expect(native.focus).toHaveBeenCalledTimes(2));
    expect(native.create).toHaveBeenCalledOnce(); expect(native.close).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
    act(() => native.listener?.({ surfaceId: 'native-1', kind: 'input', data: btoa('blocked') }));
    expect(input).not.toHaveBeenCalled();
  } finally { rectangle.mockRestore(); }
});
