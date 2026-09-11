import { TERMINAL_CODEC } from '@weave/product-protocol';
const bytes = (text: string) => new TextEncoder().encode(text);
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalAttachmentMode, TerminalNotification, TerminalSummary } from '@weave/product-protocol';
import { PortalRpcError } from '@/portal-client';
import { type AlphaTerminalClient, useAlphaTerminals } from './use-alpha-terminals';

const terminal = (terminalId = 'terminal-1'): TerminalSummary => ({
  terminalId,
  executionContextId: 'workspace-1',
  title: 'zsh',
  status: 'running',
  cols: 80,
  rows: 24,
});

const client = (
  options: {
    controlled?: boolean;
    terminals?: TerminalSummary[];
    eventDuringAttach?: boolean;
  } = {},
) => {
  let onEvent: ((notification: TerminalNotification) => void) | undefined;
  const terminals = options.terminals ?? [];
  const value: AlphaTerminalClient & {
    emit(notification: TerminalNotification): void;
    setTerminals(next: TerminalSummary[]): void;
  } = {
    listTerminals: vi.fn(async () => ({ terminals: [...terminals] })),
    createTerminal: vi.fn(async () => ({ terminal: terminal() })),
    attachTerminal: vi.fn(
      async (
        _executionContextId: string,
        terminalId: string,
        mode: TerminalAttachmentMode,
        listener: (notification: TerminalNotification) => void,
      ) => {
        onEvent = listener;
        const result = {
          attachment: { attachmentId: `attachment-${mode}`, mode },
          snapshot: { codec: TERMINAL_CODEC as typeof TERMINAL_CODEC,
            terminal: terminal(terminalId),
            generation: 'generation-1',
            cursor: 0,
            retainedFrom: 1,
            data: bytes('$ '),

          },
          startEvents: () => {
            if (!options.eventDuringAttach) return;
            listener({
              attachmentId: `attachment-${mode}`,
              terminalId,
              executionContextId: 'workspace-1',
              generation: 'generation-1',
              sequence: 1,
              event: { type: 'output', data: bytes('raced\r\n') },
            });
          },
        };
        return result;
      },
    ),
    inputTerminal: vi.fn(async () => ({ accepted: true as const })),
    resizeTerminal: vi.fn(async () => ({ accepted: true as const })),
    detachTerminal: vi.fn(async () => ({ detached: true as const })),
    closeTerminal: vi.fn(async () => ({ closed: true as const })),
    emit(notification) {
      onEvent?.(notification);
    },
    setTerminals(next) {
      terminals.splice(0, terminals.length, ...next);
    },
  };
  return value;
};

const target = {
  scope: {
    hostId: 'host-1',
    contextId: 'project-1',
    executionContextId: 'workspace-1',
  },
  supported: true,
};

describe('useAlphaTerminals', () => {
  it('creates and controls the first Terminal and preserves its attachment across hide and reopen', async () => {
    const host = client();
    let renders = 0;
    const { result } = renderHook(() => { renders++; return useAlphaTerminals({ target, client: host }); });
    let rendered = '';
    result.current.model.output!.subscribe({ reset: async (data) => { rendered = new TextDecoder().decode(data); }, write: async (data) => { rendered += new TextDecoder().decode(data); } });

    await act(() => result.current.actions.show());
    expect(host.createTerminal).toHaveBeenCalledWith('workspace-1');
    expect(result.current.model.attachmentMode).toBe('shared');
    expect(rendered).toBe('$ ');
    const beforeOutput = renders;

    act(() =>
      host.emit({
        attachmentId: 'attachment-shared',
        terminalId: 'terminal-1',
        executionContextId: 'workspace-1',
        generation: 'generation-1',
        sequence: 1,
        event: { type: 'output', data: bytes('ready\r\n') },
      })
    );
    await waitFor(() => expect(rendered).toBe('$ ready\r\n'));
    expect(renders).toBe(beforeOutput);

    await act(() => result.current.actions.input('echo ready\r'));
    expect(host.inputTerminal).toHaveBeenCalledWith(
      'workspace-1',
      'terminal-1',
      'attachment-shared',
      'echo ready\r',
    );
    await act(() => result.current.actions.hide());
    expect(host.detachTerminal).not.toHaveBeenCalled();
    expect(result.current.model.attachmentId).toBe('attachment-shared');

    await act(() => result.current.actions.show());
    expect(host.listTerminals).toHaveBeenCalledOnce();
    expect(host.attachTerminal).toHaveBeenCalledOnce();
    expect(result.current.model.attachmentId).toBe('attachment-shared');
    expect(host.closeTerminal).not.toHaveBeenCalled();
  });

  it('keeps attachment demand scoped while changing projects and Hosts', async () => {
    const first = client();
    const second = client();
    const { result, rerender } = renderHook(
      ({ nextTarget, host }) =>
        useAlphaTerminals({ target: nextTarget, client: host }),
      { initialProps: { nextTarget: target, host: first } },
    );

    await act(() => result.current.actions.show());
    rerender({
      nextTarget: {
        scope: {
          hostId: 'host-2',
          contextId: 'project-2',
          executionContextId: 'workspace-2',
        },
        supported: true,
      },
      host: second,
    });
    await act(async () => await Promise.resolve());

    expect(first.detachTerminal).toHaveBeenCalledWith(
      'workspace-1',
      'terminal-1',
      'attachment-shared',
    );
    expect(second.listTerminals).not.toHaveBeenCalled();
    expect(second.createTerminal).not.toHaveBeenCalled();

    await act(() => result.current.actions.show());
    expect(second.listTerminals).toHaveBeenCalledWith('workspace-2');
    await act(() => result.current.actions.hide());

    rerender({ nextTarget: target, host: first });
    await waitFor(() => expect(first.listTerminals).toHaveBeenCalledTimes(2));
    expect(second.detachTerminal).toHaveBeenCalledWith(
      'workspace-2',
      'terminal-1',
      'attachment-shared',
    );
  });

  it('opens shared input even when a legacy controller is attached elsewhere', async () => {
    const host = client({ controlled: true, terminals: [terminal()] });
    const { result } = renderHook(() => useAlphaTerminals({ target, client: host }));
    await act(() => result.current.actions.show());
    expect(host.attachTerminal).toHaveBeenCalledExactlyOnceWith('workspace-1', 'terminal-1', 'shared', expect.any(Function));
    expect(result.current.model.attachmentMode).toBe('shared');
    expect(result.current.model.readOnlyReason).toBeUndefined();
    await act(() => result.current.actions.input('hello'));
    expect(host.inputTerminal).toHaveBeenCalledWith('workspace-1', 'terminal-1', 'attachment-shared', 'hello');
  });

  it('installs the snapshot before releasing attach-time notifications', async () => {
    const host = client({ eventDuringAttach: true });
    const { result } = renderHook(() => useAlphaTerminals({ target, client: host }));

    await act(() => result.current.actions.show());
    let rendered = '';
    result.current.model.output!.subscribe({ reset: async (data) => { rendered = new TextDecoder().decode(data); }, write: async (data) => { rendered += new TextDecoder().decode(data); } });
    await waitFor(() => expect(rendered).toBe('$ raced\r\n'));
  });

  it('recovers a renderer overflow by reattaching the same terminal without creating or terminating a process', async () => {
    const host = client({ terminals: [terminal()] });
    const { result } = renderHook(() => useAlphaTerminals({ target: { ...target, terminalId: 'terminal-1' }, client: host }));
    await waitFor(() => expect(result.current.model.attachmentId).toBe('attachment-shared'));
    const stop = result.current.model.output!.subscribe({ reset: async () => undefined, write: async () => undefined });
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      host.emit({ attachmentId: 'attachment-shared', terminalId: 'terminal-1', executionContextId: 'workspace-1', generation: 'generation-1', sequence: 1, event: { type: 'output', data: bytes('x'.repeat(2 * 1024 * 1024 + 1)) } });
    });
    await waitFor(() => expect(host.attachTerminal).toHaveBeenCalledTimes(2));
    expect(host.createTerminal).not.toHaveBeenCalled();
    expect(host.closeTerminal).not.toHaveBeenCalled();
    expect(host.detachTerminal).toHaveBeenCalledOnce();
    expect(result.current.model.activeTerminalId).toBe('terminal-1');
    stop();
  });

  it('clears a naturally exited attachment and reconciles a replacement Terminal', async () => {
    const host = client({ terminals: [terminal()] });
    const { result } = renderHook(() => useAlphaTerminals({ target, client: host }));

    await act(() => result.current.actions.show());
    host.setTerminals([]);
    await act(async () => {
      host.emit({
        attachmentId: 'attachment-shared',
        terminalId: 'terminal-1',
        executionContextId: 'workspace-1',
        generation: 'generation-1',
        sequence: 1,
        event: { type: 'exit', exitCode: 0 },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.detachTerminal).toHaveBeenCalledWith(
      'workspace-1',
      'terminal-1',
      'attachment-shared',
    );
    expect(host.createTerminal).toHaveBeenCalledOnce();
    expect(host.attachTerminal).toHaveBeenCalledTimes(2);
    expect(result.current.model.attachmentMode).toBe('shared');
  });

  it('awaits resync detachment and preserves the active Terminal', async () => {
    const host = client({ terminals: [terminal('terminal-1'), terminal('terminal-2')] });
    const { result } = renderHook(() => useAlphaTerminals({ target, client: host }));

    await act(() => result.current.actions.show());
    await act(() => result.current.actions.select('terminal-2'));
    let releaseDetach: (() => void) | undefined;
    vi.mocked(host.detachTerminal).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDetach = () => resolve({ detached: true as const });
        }),
    );

    await act(async () => {
      host.emit({
        attachmentId: 'attachment-shared',
        terminalId: 'terminal-2',
        executionContextId: 'workspace-1',
        generation: 'generation-1',
        sequence: 1,
        event: { type: 'resync', retainedFrom: 1 },
      });
      await Promise.resolve();
    });
    expect(host.attachTerminal).toHaveBeenCalledTimes(2);

    await act(async () => {
      releaseDetach?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(host.attachTerminal).toHaveBeenCalledTimes(3));
    expect(host.attachTerminal).toHaveBeenLastCalledWith(
      'workspace-1',
      'terminal-2',
      'shared',
      expect.any(Function),
    );
    expect(result.current.model.activeTerminalId).toBe('terminal-2');
  });

  it('preserves the active Terminal when the Portal client is replaced', async () => {
    const terminals = [terminal('terminal-1'), terminal('terminal-2')];
    const first = client({ terminals });
    const second = client({ terminals });
    const { result, rerender } = renderHook(
      ({ host }) => useAlphaTerminals({ target, client: host }),
      { initialProps: { host: first } },
    );

    await act(() => result.current.actions.show());
    await act(() => result.current.actions.select('terminal-2'));
    vi.mocked(first.detachTerminal).mockRejectedValue(new Error('Previous Host connection closed'));
    rerender({ host: second });

    await waitFor(() => expect(second.attachTerminal).toHaveBeenCalled());
    expect(second.attachTerminal).toHaveBeenLastCalledWith(
      'workspace-1',
      'terminal-2',
      'shared',
      expect.any(Function),
    );
    expect(result.current.model.activeTerminalId).toBe('terminal-2');
    await act(() => result.current.actions.close('terminal-2'));
    expect(second.closeTerminal).toHaveBeenCalledWith('workspace-1', 'terminal-2', expect.any(String));
    expect(first.closeTerminal).not.toHaveBeenCalled();
  });
});

it('reports a missing composition terminal for removal without creating or attaching a replacement', async () => {
  const host = client({ terminals: [terminal('unrelated')] });
  const onExit = vi.fn();
  const { result } = renderHook(() => useAlphaTerminals({ target: { ...target, terminalId: 'missing' }, client: host, onExit }));
  await waitFor(() => expect(onExit).toHaveBeenCalledWith('missing'));
  expect(result.current.model.error).toBeUndefined();
  expect(host.createTerminal).not.toHaveBeenCalled();
  expect(host.attachTerminal).not.toHaveBeenCalled();
  expect(result.current.model.activeTerminalId).toBeUndefined();
});

it('detaches a late attachment after its composition pane has unmounted', async () => {
  const host = client({ terminals: [terminal()] });
  const original = host.attachTerminal;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  host.attachTerminal = vi.fn(async (...args: Parameters<typeof original>) => { await gate; return original(...args); });
  const { unmount } = renderHook(() => useAlphaTerminals({ target: { ...target, terminalId: 'terminal-1' }, client: host }));
  await waitFor(() => expect(host.attachTerminal).toHaveBeenCalled());
  unmount();
  await act(async () => { release(); await gate; });
  await waitFor(() => expect(host.detachTerminal).toHaveBeenCalledWith('workspace-1', 'terminal-1', 'attachment-shared'));
  expect(host.closeTerminal).not.toHaveBeenCalled();
});


it('replaces the authoritative grid without reattaching or reporting a local resize', async () => {
  const host = client();
  const { result, unmount } = renderHook(() => useAlphaTerminals({ target, client: host }));
  const reset = vi.fn(async () => undefined), write = vi.fn(async () => undefined);
  result.current.model.output!.subscribe({ reset, write });
  await act(() => result.current.actions.show());
  reset.mockClear();
  const notification = { attachmentId: 'attachment-shared', terminalId: 'terminal-1', executionContextId: 'workspace-1', generation: 'generation-1' };
  await act(async () => {
    host.emit({ ...notification, sequence: 1, event: { type: 'screen', terminal: { ...terminal(), cols: 150, rows: 50 }, data: bytes('remote screen') } });
    host.emit({ ...notification, sequence: 2, event: { type: 'output', data: bytes('later output') } });
  });
  expect(reset).toHaveBeenCalledWith(bytes('remote screen'), { cols: 150, rows: 50 });
  expect(write).toHaveBeenCalledWith(bytes('later output'));
  expect(result.current.model.tabs[0]).toMatchObject({ cols: 150, rows: 50 });
  expect(host.attachTerminal).toHaveBeenCalledTimes(1);
  expect(host.resizeTerminal).not.toHaveBeenCalled();
  unmount();
});

it('reports a pinned terminal exit once without reconnecting or creating a new shell', async () => {
  const host = client({ terminals: [terminal(), terminal('other')] });
  const onExit = vi.fn();
  const { result } = renderHook(() => useAlphaTerminals({ target: { ...target, terminalId: 'terminal-1' }, client: host, onExit }));
  await waitFor(() => expect(result.current.model.attachmentId).toBe('attachment-shared'));
  await act(async () => host.emit({ attachmentId: 'attachment-shared', terminalId: 'terminal-1', executionContextId: 'workspace-1', generation: 'generation-1', sequence: 2, event: { type: 'exit', exitCode: 0 } }));
  expect(onExit).toHaveBeenCalledExactlyOnceWith('terminal-1');
  expect(result.current.model.attachmentId).toBeUndefined();
  expect(host.attachTerminal).toHaveBeenCalledTimes(1);
  expect(host.listTerminals).toHaveBeenCalledTimes(1);
  expect(host.createTerminal).not.toHaveBeenCalled();
});
