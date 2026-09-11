import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { PortalTransportError } from '@/portal-client';
import type { AlphaExecutionContext } from './alpha-controller';
import { useWorkspaceCompositions, type CompositionClient } from './use-workspace-compositions';

vi.mock('@capacitor/preferences', () => ({ Preferences: {
  get: vi.fn(async () => ({ value: null })), set: vi.fn(async () => undefined),
} }));

it('keeps WebSocket failures out of workspace alerts without hiding actionable composition errors', async () => {
  const client = { listTerminals: vi.fn(async () => ({ terminals: [] })), getWorkspaceComposition: vi.fn().mockRejectedValue(new PortalTransportError('The Host WebSocket closed (1006).')) } as unknown as CompositionClient;
  const executionContexts = [{ id: 'host:workspace', hostId: 'host', executionContextId: 'workspace' }] as AlphaExecutionContext[];
  const connections = [{ hostId: 'host', available: true, supported: true, client }];
  const { result } = renderHook(() => useWorkspaceCompositions(executionContexts, connections));
  await waitFor(() => expect(result.current.model.loading).toBe(false));
  await act(() => result.current.actions.refresh());
  expect(result.current.model.error).toBeUndefined();
  await act(() => result.current.actions.open('host:workspace'));
  expect(result.current.model.error).toBeUndefined();
  vi.mocked(client.getWorkspaceComposition).mockRejectedValue(new Error('Unsupported saved composition schema.'));
  await act(() => result.current.actions.refresh());
  expect(result.current.model.error).toBe('Unsupported saved composition schema.');
});

it('accepts Host exit cleanup, removes stale focus and maximization, and never provisions replacement panes', async () => {
  const pane = (id: string) => ({ kind: 'terminal' as const, executionContextId: 'workspace', nodeId: id, paneId: id, terminalId: id });
  let composition: import('@weave/product-protocol').WorkspaceComposition = { schemaVersion: 2, hostId: 'host', revision: 4, workspaces: [{ workspaceId: 'tab', name: 'Existing', layout: { kind: 'split', nodeId: 'split', axis: 'horizontal', ratio: 0.4, children: [pane('one'), pane('two')] } }] };
  const client = { listTerminals: vi.fn(async () => ({ terminals: [] })), getWorkspaceComposition: vi.fn(async () => ({ composition })), replaceWorkspaceComposition: vi.fn(), createTerminal: vi.fn() } as unknown as CompositionClient;
  const executionContexts = [{ id: 'host:workspace', hostId: 'host', executionContextId: 'workspace' }] as AlphaExecutionContext[];
  const { result } = renderHook(() => useWorkspaceCompositions(executionContexts, [{ hostId: 'host', available: true, supported: true, client }]));
  await waitFor(() => expect(result.current.model.compositions.host?.revision).toBe(4));
  const reference = { hostId: 'host', workspaceId: 'tab' }, key = JSON.stringify(['host', 'tab']);
  act(() => { result.current.actions.focus(reference, 'two'); result.current.actions.maximize(reference, 'two'); });
  composition = { ...composition, revision: 5, workspaces: [{ ...composition.workspaces[0]!, layout: pane('one') }] };
  await act(() => result.current.actions.refresh());
  expect(result.current.model.presentation.focusedPanes[key]).toBe('one');
  expect(result.current.model.presentation.maximizedPanes[key]).toBeUndefined();
  composition = { ...composition, revision: 6, workspaces: [{ ...composition.workspaces[0]!, layout: null }] };
  await act(() => result.current.actions.refresh());
  expect(result.current.model.presentation.focusedPanes[key]).toBeUndefined();
  expect(result.current.model.compositions.host?.workspaces[0]?.layout).toBeNull();
  expect(client.replaceWorkspaceComposition).not.toHaveBeenCalled();
  expect(client.createTerminal).not.toHaveBeenCalled();
});

it('reveals the chosen terminal tile while retaining maximized mode and independent Thread selection', async () => {
  const { result } = renderHook(() => useWorkspaceCompositions([], []));
  await waitFor(() => expect(result.current.model.loading).toBe(false));
  const reference = { hostId: 'host', workspaceId: 'workspace' };
  const key = JSON.stringify(['host', 'workspace']);
  await act(() => result.current.actions.maximize(reference, 'first'));
  await act(() => result.current.actions.focus(reference, 'second'));
  expect(result.current.model.presentation.activeWorkspace).toBe(key);
  expect(result.current.model.presentation.focusedPanes[key]).toBe('second');
  expect(result.current.model.presentation.maximizedPanes[key]).toBe('second');
});
