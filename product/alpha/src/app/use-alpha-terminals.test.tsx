import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalAttachmentMode, TerminalNotification, TerminalSummary } from '@weave/product-protocol';
import { PortalRpcError } from '@/portal-client';
import { type AlphaTerminalClient, useAlphaTerminals } from './use-alpha-terminals';

const terminal = (terminalId = 'terminal-1'): TerminalSummary => ({
  terminalId,
  workspaceId: 'workspace-1',
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
        _workspaceId: string,
        terminalId: string,
        mode: TerminalAttachmentMode,
        listener: (notification: TerminalNotification) => void,
      ) => {
        if (mode === 'control' && options.controlled) {
          throw new PortalRpcError(
            -32012,
            'Terminal is controlled by another attachment.',
            { domain: 'terminal', code: 'TERMINAL_CONTROLLED' },
          );
        }
        onEvent = listener;
        const result = {
          attachment: { attachmentId: `attachment-${mode}`, mode },
          snapshot: {
            terminal: terminal(terminalId),
            generation: 'generation-1',
            cursor: 0,
            retainedFrom: 1,
            data: '$ ',
            controller: mode === 'control'
              ? {
                controlled: true as const,
                attachmentId: 'attachment-control',
              }
              : {
                controlled: true as const,
                attachmentId: 'another-controller',
              },
          },
          startEvents: () => {
            if (!options.eventDuringAttach) return;
            listener({
              attachmentId: `attachment-${mode}`,
              terminalId,
              workspaceId: 'workspace-1',
              generation: 'generation-1',
              sequence: 1,
              event: { type: 'output', data: 'raced\r\n' },
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
    projectId: 'project-1',
    workspaceId: 'workspace-1',
  },
  supported: true,
};

describe('useAlphaTerminals', () => {
  it('creates and controls the first Terminal and preserves its attachment across hide and reopen', async () => {
    const host = client();
    const { result } = renderHook(() => useAlphaTerminals({ target, client: host }));

    await act(() => result.current.actions.show());
    expect(host.createTerminal).toHaveBeenCalledWith('workspace-1');
    expect(result.current.model.attachmentMode).toBe('control');
    expect(result.current.model.data).toBe('$ ');

    act(() =>
      host.emit({
        attachmentId: 'attachment-control',
        terminalId: 'terminal-1',
        workspaceId: 'workspace-1',
        generation: 'generation-1',
        sequence: 1,
        event: { type: 'output', data: 'ready\r\n' },
      })
    );
    expect(result.current.model.data).toBe('$ ready\r\n');

    await act(() => result.current.actions.input('echo ready\r'));
    expect(host.inputTerminal).toHaveBeenCalledWith(
      'workspace-1',
      'terminal-1',
      'attachment-control',
      'echo ready\r',
    );
    await act(() => result.current.actions.hide());
    expect(host.detachTerminal).not.toHaveBeenCalled();
    expect(result.current.model.attachmentId).toBe('attachment-control');

    await act(() => result.current.actions.show());
    expect(host.listTerminals).toHaveBeenCalledOnce();
    expect(host.attachTerminal).toHaveBeenCalledOnce();
    expect(result.current.model.attachmentId).toBe('attachment-control');
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
          projectId: 'project-2',
          workspaceId: 'workspace-2',
        },
        supported: true,
      },
      host: second,
    });
    await act(async () => await Promise.resolve());

    expect(first.detachTerminal).toHaveBeenCalledWith(
      'workspace-1',
      'terminal-1',
      'attachment-control',
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
      'attachment-control',
    );
  });

  it('falls back to an explicit read-only observer when control is held elsewhere', async () => {
    const host = client({ controlled: true, terminals: [terminal()] });
    const { result } = renderHook(() => useAlphaTerminals({ target, client: host }));

    await act(() => result.current.actions.show());
    expect(host.attachTerminal).toHaveBeenNthCalledWith(
      1,
      'workspace-1',
      'terminal-1',
      'control',
      expect.any(Function),
    );
    expect(host.attachTerminal).toHaveBeenNthCalledWith(
      2,
      'workspace-1',
      'terminal-1',
      'observe',
      expect.any(Function),
    );
    expect(result.current.model.attachmentMode).toBe('observe');
    expect(result.current.model.readOnlyReason).toContain('controlled');

    await act(() => result.current.actions.input('forbidden'));
    expect(host.inputTerminal).not.toHaveBeenCalled();
  });

  it('installs the snapshot before releasing attach-time notifications', async () => {
    const host = client({ eventDuringAttach: true });
    const { result } = renderHook(() => useAlphaTerminals({ target, client: host }));

    await act(() => result.current.actions.show());
    expect(result.current.model.data).toBe('$ raced\r\n');
  });

  it('clears a naturally exited attachment and reconciles a replacement Terminal', async () => {
    const host = client({ terminals: [terminal()] });
    const { result } = renderHook(() => useAlphaTerminals({ target, client: host }));

    await act(() => result.current.actions.show());
    host.setTerminals([]);
    await act(async () => {
      host.emit({
        attachmentId: 'attachment-control',
        terminalId: 'terminal-1',
        workspaceId: 'workspace-1',
        generation: 'generation-1',
        sequence: 1,
        event: { type: 'exit', exitCode: 0 },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.detachTerminal).toHaveBeenCalledWith(
      'workspace-1',
      'terminal-1',
      'attachment-control',
    );
    expect(host.createTerminal).toHaveBeenCalledOnce();
    expect(host.attachTerminal).toHaveBeenCalledTimes(2);
    expect(result.current.model.attachmentMode).toBe('control');
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
        attachmentId: 'attachment-control',
        terminalId: 'terminal-2',
        workspaceId: 'workspace-1',
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
      'control',
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
    rerender({ host: second });

    await waitFor(() => expect(second.attachTerminal).toHaveBeenCalled());
    expect(second.attachTerminal).toHaveBeenLastCalledWith(
      'workspace-1',
      'terminal-2',
      'control',
      expect.any(Function),
    );
    expect(result.current.model.activeTerminalId).toBe('terminal-2');
  });
});

it('retains a missing composition target without creating or attaching another terminal', async () => {
  const host = client({ terminals: [terminal('unrelated')] });
  const { result } = renderHook(() => useAlphaTerminals({ target: { ...target, terminalId: 'missing' }, client: host }));
  await waitFor(() => expect(result.current.model.error).toContain('pane is retained'));
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
  await waitFor(() => expect(host.detachTerminal).toHaveBeenCalledWith('workspace-1', 'terminal-1', 'attachment-control'));
  expect(host.closeTerminal).not.toHaveBeenCalled();
});
