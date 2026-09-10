import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalOutputStream } from '@/terminal/output-stream';
import { XtermTerminalView } from './xterm-terminal-view';

const xterm = vi.hoisted(() => {
  let dataListener: ((data: string) => void) | undefined;
  const write = vi.fn((_data: string, callback?: () => void) => callback?.());
  const reset = vi.fn();
  const dispose = vi.fn();
  const open = vi.fn();
  const focus = vi.fn();
  const loadAddon = vi.fn();
  const onData = vi.fn((listener: (data: string) => void) => {
    dataListener = listener;
    return { dispose: vi.fn() };
  });
  const fit = vi.fn();
  const disposeFit = vi.fn();
  const terminal = {
    resize: vi.fn(),
    cols: 100,
    rows: 30,
    options: { disableStdin: false },
    write,
    reset,
    dispose,
    open,
    focus,
    loadAddon,
    onData,
  };
  return {
    terminal,
    write,
    reset,
    dispose,
    open,
    focus,
    loadAddon,
    onData,
    fit,
    disposeFit,
    emitData: (data: string) => dataListener?.(data),
  };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor() {
      return xterm.terminal;
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    constructor() {
      return { fit: xterm.fit, dispose: xterm.disposeFit };
    }
  },
}));

class TestResizeObserver {
  static callback: ResizeObserverCallback | undefined;
  constructor(callback: ResizeObserverCallback) {
    TestResizeObserver.callback = callback;
  }
  observe = vi.fn();
  disconnect = vi.fn();
}

describe('XtermTerminalView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 800, height: 480 } as DOMRect);
    TestResizeObserver.callback = undefined;
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    xterm.terminal.options.disableStdin = false;
  });

  it('opens xterm, writes only appended output, and replaces divergent snapshots', async () => {
    const { container, rerender, unmount } = render(
      <XtermTerminalView data={'hello\r\n'} readOnly={false} />,
    );

    expect(xterm.open).toHaveBeenCalledWith(
      container.querySelector('[data-slot="xterm-terminal"]'),
    );
    expect(xterm.write.mock.calls.at(-1)?.[0]).toBe('hello\r\n');

    rerender(<XtermTerminalView data={'hello\r\nworld'} readOnly={false} />);
    expect(xterm.write).toHaveBeenLastCalledWith('world');
    expect(xterm.reset).not.toHaveBeenCalled();

    rerender(<XtermTerminalView data={'fresh'} dataEpoch={1} readOnly={false} />);
    expect(xterm.reset).toHaveBeenCalledOnce();
    expect(xterm.write.mock.calls.at(-1)?.[0]).toBe('fresh');

    unmount();
    await waitFor(() => expect(xterm.dispose).toHaveBeenCalledOnce());
  });


  it('consumes live output without React prop updates and gates protocol replies during a streamed snapshot', async () => {
    const resync = vi.fn();
    const output = new TerminalOutputStream(resync);
    const input = vi.fn();
    let finish: (() => void) | undefined;
    xterm.write.mockImplementationOnce((_data: string, callback?: () => void) => { finish = callback; });
    output.reset('snapshot');
    const { container, unmount } = render(<XtermTerminalView output={output} readOnly={false} onInput={input} />);
    fireEvent.pointerDown(container.querySelector('[data-slot="xterm-terminal"]')!);
    act(() => xterm.emitData('snapshot protocol reply'));
    expect(input).not.toHaveBeenCalled();
    output.write('live');
    expect(xterm.write).toHaveBeenCalledTimes(1);
    await act(async () => { finish!(); });
    expect(xterm.write.mock.calls.map(([data]) => data)).toEqual(['snapshot', 'live']);
    act(() => xterm.emitData('typed input'));
    expect(input).toHaveBeenCalledWith('typed input');
    unmount();
    render(<XtermTerminalView output={output} readOnly={false} />);
    expect(resync).toHaveBeenCalledOnce();
  });

  it('puts viewport padding on xterm so fitting reserves the final input row', () => {
    const { container } = render(
      <XtermTerminalView data='' readOnly={false} />,
    );
    const host = container.querySelector('[data-slot="xterm-terminal"]');

    expect(host).toHaveClass('[&>.xterm]:p-2');
    expect(host).not.toHaveClass('p-2');
  });

  it('forwards control input and fitted dimensions but suppresses input while read-only', () => {
    const input = vi.fn();
    const resize = vi.fn();
    const { rerender } = render(
      <XtermTerminalView
        data=''
        readOnly={false}
        onInput={input}
        onResize={resize}
      />,
    );
    const dataListener = xterm.onData.mock.calls[0]?.[0] as ((data: string) => void) | undefined;

    fireEvent.pointerDown(document.querySelector('[data-slot="xterm-terminal"]')!);
    act(() => dataListener?.('ls\r'));
    expect(input).toHaveBeenCalledWith('ls\r');

    act(() => TestResizeObserver.callback?.([], {} as ResizeObserver));
    expect(xterm.fit).toHaveBeenCalled();
    expect(resize).toHaveBeenCalledWith(100, 30);

    rerender(
      <XtermTerminalView data='' readOnly onInput={input} onResize={resize} />,
    );
    expect(xterm.terminal.options.disableStdin).toBe(true);
    act(() => dataListener?.('blocked'));
    expect(input).not.toHaveBeenCalledWith('blocked');
  });

  it('publishes fitted dimensions when a late Host attachment grants control', () => {
    const resize = vi.fn();
    const { rerender } = render(<XtermTerminalView data='' readOnly onResize={resize} />);
    resize.mockClear(); // The first measurement had no controlling attachment.
    rerender(<XtermTerminalView data='' readOnly={false} onResize={resize} />);
    expect(resize).toHaveBeenCalledWith(100, 30);
    resize.mockClear();
    rerender(<XtermTerminalView data='' dataEpoch={1} readOnly={false} onResize={resize} />);
    expect(resize).toHaveBeenCalledWith(100, 30);
  });

  it('appends across a retained-data truncation without resetting xterm', () => {
    const { rerender } = render(
      <XtermTerminalView data='abcd' dataEpoch={7} dataOffset={0} readOnly={false} />,
    );

    rerender(
      <XtermTerminalView data='cdef' dataEpoch={7} dataOffset={2} readOnly={false} />,
    );

    expect(xterm.reset).not.toHaveBeenCalled();
    expect(xterm.write.mock.calls.at(-1)?.[0]).toBe('ef');
  });

  it('suppresses delayed xterm protocol replies until snapshot replay completes', () => {
    const input = vi.fn();
    let finishReplay: (() => void) | undefined;
    xterm.write.mockImplementationOnce(
      (_data: string, callback?: () => void) => {
        finishReplay = callback;
      },
    );

    render(
      <XtermTerminalView
        data={'\x1b]11;?\x1b\\'}
        readOnly={false}
        onInput={input}
      />,
    );
    fireEvent.pointerDown(document.querySelector('[data-slot="xterm-terminal"]')!);
    act(() => xterm.emitData('\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\'));
    expect(input).not.toHaveBeenCalled();

    act(() => finishReplay?.());
    act(() => xterm.emitData('user input'));
    expect(input).toHaveBeenCalledWith('user input');
  });
});
