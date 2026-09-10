import { useEffect, useRef, useState } from 'react';
import { terminalPaneTargets, type TerminalLayoutNode, type WorkspaceComposition, type WorkspaceTab } from '@weave/product-protocol';
import type { DirectHostClient } from '@/portal-client';
import type { AlphaWorkspace } from './alpha-controller';
import {
  activateWorkspaceTab, closeWorkspaceTab, emptyWorkspacePresentation, loadWorkspacePresentation,
  saveWorkspacePresentation, tabReferenceKey, workspaceReferenceKey,
  type WorkspacePresentation, type WorkspaceTabReference,
} from './workspace-presentation';

export type CompositionClient = Pick<DirectHostClient, 'getWorkspaceComposition' | 'replaceWorkspaceComposition' | 'createTerminal' | 'listTerminals'>;
export type CompositionConnection = { hostId: string; available: boolean; supported: boolean; client?: CompositionClient };
export type WorkspaceCompositionsModel = {
  presentation: WorkspacePresentation;
  compositions: Record<string, WorkspaceComposition>;
  loading: boolean;
  pending: boolean;
  error?: string;
};
export type WorkspaceCompositionActions = {
  open(workspaceId: string, create?: boolean): Promise<void>;
  activate(tab: WorkspaceTabReference): void;
  close(tab: WorkspaceTabReference): void;
  rename(tab: WorkspaceTabReference, name: string): Promise<boolean>;
  move(tab: WorkspaceTabReference, direction: -1 | 1): void;
  adoptTerminal(tab: WorkspaceTabReference, paneId: string, terminalId: string): Promise<boolean>;
  split(tab: WorkspaceTabReference, paneId: string, axis: 'horizontal' | 'vertical'): Promise<void>;
  setRatio(tab: WorkspaceTabReference, nodeId: string, ratio: number): Promise<void>;
  startTerminal(tab: WorkspaceTabReference, paneId: string): Promise<void>;
  focus(tab: WorkspaceTabReference, paneId: string): void;
  maximize(tab: WorkspaceTabReference, paneId: string): void;
  collapse(contextId: string): void;
  refresh(): Promise<void>;
};
const emptyPane = (): TerminalLayoutNode => ({ kind: 'terminal', nodeId: crypto.randomUUID(), paneId: crypto.randomUUID(), terminalId: null });
const mapLayout = (node: TerminalLayoutNode, transform: (node: TerminalLayoutNode) => TerminalLayoutNode): TerminalLayoutNode =>
  transform(node.kind === 'split' ? { ...node, children: [mapLayout(node.children[0], transform), mapLayout(node.children[1], transform)] } : node);

export function useWorkspaceCompositions(workspaces: AlphaWorkspace[], connections: CompositionConnection[], connectionsLoaded = true) {
  const [presentation, setPresentation] = useState(emptyWorkspacePresentation);
  const [compositions, setCompositions] = useState<Record<string, WorkspaceComposition>>({});
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const state = useRef({ presentation, compositions, workspaces, connections });
  state.current = { presentation, compositions, workspaces, connections };
  const mounted = useRef(true);
  const writes = useRef(Promise.resolve());
  const saving = useRef(Promise.resolve());
  const load = useRef<Promise<void> | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    load.current = loadWorkspacePresentation().then((value) => {
      if (mounted.current) { state.current.presentation = value; setPresentation(value); }
    }).catch(() => { if (mounted.current) setError('Could not restore open workspaces. Saved Host arrangements are still available.'); })
      .finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; };
  }, []);
  const updatePresentation = (update: (current: WorkspacePresentation) => WorkspacePresentation) => {
    const next = update(state.current.presentation);
    state.current.presentation = next;
    setPresentation(next);
    saving.current = saving.current.catch(() => undefined).then(() => saveWorkspacePresentation(next))
      .catch(() => { if (mounted.current) setError('Could not save workspace focus on this device.'); });
  };
  const knownHostsKey = JSON.stringify(connections.map((connection) => connection.hostId).sort());
  useEffect(() => {
    if (loading || !connectionsLoaded) return;
    const known = new Set(state.current.connections.map((connection) => connection.hostId));
    const forgotten = state.current.presentation.openTabs.filter((tab) => !known.has(tab.hostId));
    if (forgotten.length) updatePresentation((current) => forgotten.reduce((next, tab) => closeWorkspaceTab(next, tabReferenceKey(tab)), current));
  }, [loading, connectionsLoaded, knownHostsKey]);

  const remember = (hostId: string, composition: WorkspaceComposition) => {
    const key = workspaceReferenceKey(hostId, composition.workspaceId);
    if ((state.current.compositions[key]?.revision ?? -1) > composition.revision) return;
    const next = { ...state.current.compositions, [key]: composition };
    state.current.compositions = next;
    if (mounted.current) setCompositions(next);
  };
  const clientFor = (hostId: string) => {
    const connection = state.current.connections.find((connection) => connection.hostId === hostId);
    if (!connection?.available) throw new Error('This Host is unavailable. Its workspace arrangements are retained.');
    if (!connection.supported || !connection.client) throw new Error('Update this Host to use persistent terminal workspaces.');
    return connection.client;
  };
  const refresh = async () => {
    const requests = state.current.workspaces.flatMap((workspace) => (workspace.placements ?? [workspace]).map(async (placement) => {
      const connection = state.current.connections.find((connection) => connection.hostId === placement.hostId);
      if (!connection?.available || !connection.supported || !connection.client) return;
      const result = await connection.client.getWorkspaceComposition(placement.workspaceId);
      if (mounted.current && state.current.connections.some((item) => item.hostId === connection.hostId && item.client === connection.client)) remember(placement.hostId, result.composition);
    }));
    const results = await Promise.allSettled(requests);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected' && mounted.current) setError(failed.reason instanceof Error ? failed.reason.message : String(failed.reason));
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const topology = JSON.stringify([workspaces.map((workspace) => [workspace.id, workspace.placements]), connections.map(({ hostId, available, supported }) => [hostId, available, supported])]);
  useEffect(() => {
    void refreshRef.current();
    const timer = setInterval(() => void refreshRef.current(), 5000);
    return () => clearInterval(timer);
  }, [topology]);
  const edit = async (operation: () => Promise<void>) => {
    const next = writes.current.catch(() => undefined).then(async () => {
      await load.current;
      if (!mounted.current) return;
      setPending(true); setError(undefined);
      try { await operation(); }
      catch (cause) {
        await refreshRef.current();
        if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
      } finally { if (mounted.current) setPending(false); }
    });
    writes.current = next;
    await next;
  };
  const replace = async (ref: WorkspaceTabReference, transform: (tab: WorkspaceTab) => WorkspaceTab, base?: WorkspaceComposition) => {
    const client = clientFor(ref.hostId);
    const current = base ?? state.current.compositions[workspaceReferenceKey(ref.hostId, ref.workspaceId)];
    if (!current || !current.tabs.some((tab) => tab.tabId === ref.tabId)) throw new Error('This arrangement is unavailable. Refresh to recover it.');
    const result = await client.replaceWorkspaceComposition(ref.workspaceId, current.revision, current.tabs.map((tab) => tab.tabId === ref.tabId ? transform(tab) : tab));
    remember(ref.hostId, result.composition);
  };
  const actions: WorkspaceCompositionActions = {
    open: (contextId, create = false) => edit(async () => {
      const workspace = state.current.workspaces.find((item) => item.id === contextId);
      if (!workspace) throw new Error('This execution context is unavailable.');
      const matching = (ref: WorkspaceTabReference) => (workspace.placements ?? [workspace]).some((placement) => placement.hostId === ref.hostId && placement.workspaceId === ref.workspaceId);
      const current = state.current.presentation;
      const open = current.recentTabs.map((key) => current.openTabs.find((tab) => tabReferenceKey(tab) === key)).find((tab) => tab && matching(tab));
      if (open && !create) { updatePresentation((state) => activateWorkspaceTab(state, open)); return; }
      const client = clientFor(workspace.hostId);
      const { composition } = await client.getWorkspaceComposition(workspace.workspaceId);
      remember(workspace.hostId, composition);
      let tab = !create ? composition.tabs[0] : undefined;
      if (!tab) {
        tab = { tabId: crypto.randomUUID(), name: `Workspace ${composition.tabs.length + 1}`, layout: emptyPane() };
        const result = await client.replaceWorkspaceComposition(workspace.workspaceId, composition.revision, [...composition.tabs, tab]);
        remember(workspace.hostId, result.composition);
      }
      const ref = { hostId: workspace.hostId, workspaceId: workspace.workspaceId, tabId: tab.tabId };
      updatePresentation((state) => activateWorkspaceTab(state, ref));
    }),
    activate: (tab) => { if (!loading) updatePresentation((state) => activateWorkspaceTab(state, tab)); },
    close: (tab) => updatePresentation((state) => closeWorkspaceTab(state, tabReferenceKey(tab))),
    rename: async (tab, name) => {
      await edit(() => replace(tab, (item) => ({ ...item, name: name.trim() })));
      return state.current.compositions[workspaceReferenceKey(tab.hostId, tab.workspaceId)]?.tabs.find((item) => item.tabId === tab.tabId)?.name === name.trim();
    },
    move: (tab, direction) => updatePresentation((current) => {
      const context = state.current.workspaces.find((workspace) => (workspace.placements ?? [workspace]).some((placement) => placement.hostId === tab.hostId && placement.workspaceId === tab.workspaceId));
      if (!context) return current;
      const placements = context.placements ?? [context];
      const indices = current.openTabs.flatMap((item, index) => placements.some((placement) => placement.hostId === item.hostId && placement.workspaceId === item.workspaceId) ? [index] : []);
      const currentIndex = current.openTabs.findIndex((item) => tabReferenceKey(item) === tabReferenceKey(tab));
      const nextIndex = indices[indices.indexOf(currentIndex) + direction];
      if (currentIndex < 0 || nextIndex === undefined) return current;
      const openTabs = [...current.openTabs];
      [openTabs[currentIndex], openTabs[nextIndex]] = [openTabs[nextIndex]!, openTabs[currentIndex]!];
      return { ...current, openTabs };
    }),
    adoptTerminal: async (tab, paneId, terminalId) => {
      await edit(async () => {
        const current = state.current.compositions[workspaceReferenceKey(tab.hostId, tab.workspaceId)];
        const arrangement = current?.tabs.find((item) => item.tabId === tab.tabId);
        if (!arrangement || !terminalPaneTargets([arrangement]).some((pane) => pane.paneId === paneId)) throw new Error('This pane is no longer available. Refresh the arrangement.');
        const { terminals } = await clientFor(tab.hostId).listTerminals(tab.workspaceId);
        if (!terminals.some((terminal) => terminal.terminalId === terminalId && terminal.workspaceId === tab.workspaceId && terminal.status === 'running')) throw new Error('That terminal is no longer running in this workspace.');
        await replace(tab, (item) => ({ ...item, layout: mapLayout(item.layout, (node) => node.kind === 'terminal' && node.paneId === paneId ? { ...node, terminalId } : node) }), current);
      });
      const arrangement = state.current.compositions[workspaceReferenceKey(tab.hostId, tab.workspaceId)]?.tabs.find((item) => item.tabId === tab.tabId);
      return Boolean(arrangement && terminalPaneTargets([arrangement]).some((pane) => pane.paneId === paneId && pane.terminalId === terminalId));
    },
    split: (tab, paneId, axis) => edit(() => replace(tab, (item) => ({ ...item, layout: mapLayout(item.layout, (node) => node.kind === 'terminal' && node.paneId === paneId
      ? { kind: 'split', nodeId: crypto.randomUUID(), axis, ratio: 0.5, children: [node, emptyPane()] } : node) }))),
    setRatio: (tab, nodeId, ratio) => edit(() => replace(tab, (item) => ({ ...item, layout: mapLayout(item.layout, (node) => node.kind === 'split' && node.nodeId === nodeId ? { ...node, ratio } : node) }))),
    startTerminal: (tab, paneId) => edit(async () => {
      // A created terminal survives a failed layout edit; never terminate it as compensation.
      const current = state.current.compositions[workspaceReferenceKey(tab.hostId, tab.workspaceId)];
      const arrangement = current?.tabs.find((item) => item.tabId === tab.tabId);
      if (!arrangement || !terminalPaneTargets([arrangement]).some((pane) => pane.paneId === paneId)) throw new Error('This pane is no longer available. Refresh the arrangement.');
      const client = clientFor(tab.hostId);
      const { terminal } = await client.createTerminal(tab.workspaceId);
      await replace(tab, (item) => ({ ...item, layout: mapLayout(item.layout, (node) => node.kind === 'terminal' && node.paneId === paneId ? { ...node, terminalId: terminal.terminalId } : node) }), current);
    }),
    focus: (tab, paneId) => updatePresentation((state) => ({ ...state, focusedPanes: { ...state.focusedPanes, [tabReferenceKey(tab)]: paneId } })),
    maximize: (tab, paneId) => updatePresentation((state) => {
      const key = tabReferenceKey(tab);
      const maximizedPanes = { ...state.maximizedPanes };
      if (maximizedPanes[key] === paneId) delete maximizedPanes[key]; else maximizedPanes[key] = paneId;
      return { ...state, maximizedPanes };
    }),
    collapse: (contextId) => updatePresentation((state) => ({ ...state, collapsedContexts: state.collapsedContexts.includes(contextId) ? state.collapsedContexts.filter((id) => id !== contextId) : [...state.collapsedContexts, contextId] })),
    refresh,
  };
  return { model: { presentation, compositions, loading, pending, error } satisfies WorkspaceCompositionsModel, actions };
}
