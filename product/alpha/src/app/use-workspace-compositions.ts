import { useEffect, useRef, useState } from 'react';
import { terminalPaneTargets, type TerminalLayoutNode, type TerminalSummary, type WorkspaceComposition, type Workspace, type WorkspaceClosePlan } from '@weave/product-protocol';
import { PortalTransportError, type DirectHostClient } from '@/portal-client';
import type { AlphaExecutionContext } from './alpha-controller';
import { reconcileWorkspacePresentation, activateWorkspace, closeWorkspace, emptyWorkspacePresentation, loadWorkspacePresentation, saveWorkspacePresentation, workspaceKey, type WorkspacePresentation, type WorkspaceReference } from './workspace-presentation';

export type CompositionClient = Pick<DirectHostClient, 'getWorkspaceComposition' | 'replaceWorkspaceComposition' | 'createTerminal' | 'listTerminals'> & Partial<Pick<DirectHostClient, 'previewWorkspaceClose' | 'closeWorkspace'>>;
export type CompositionConnection = { hostId: string; available: boolean; supported: boolean; createsTerminals?: boolean; client?: CompositionClient };
export type WorkspaceCompositionsModel = {
  presentation: WorkspacePresentation;
  compositions: Record<string, WorkspaceComposition>;
  terminals: Record<string, TerminalSummary[]>;
  loading: boolean;
  pending: boolean;
  error?: string;
};
export type WorkspaceCompositionActions = {
  open(contextId: string, create?: boolean): Promise<void>;
  activate(workspace: WorkspaceReference): void;
  previewClose(workspace: WorkspaceReference): Promise<WorkspaceClosePlan>;
  close(workspace: WorkspaceReference, plan: WorkspaceClosePlan, confirmed: boolean): Promise<void>;
  rename(workspace: WorkspaceReference, name: string): Promise<boolean>;
  move(workspace: WorkspaceReference, direction: -1 | 1): void;
  split(workspace: WorkspaceReference, paneId: string, axis: 'horizontal' | 'vertical'): Promise<void>;
  setRatio(workspace: WorkspaceReference, nodeId: string, ratio: number): Promise<void>;
  addPane(workspace: WorkspaceReference, contextId: string): Promise<string | void>;
  focus(workspace: WorkspaceReference, paneId: string): void;
  maximize(workspace: WorkspaceReference, paneId: string): void;
  collapse(workspaceId: string): void;
  refresh(): Promise<void>;
};
const newPane = (executionContextId: string, launchDirectory?: string): TerminalLayoutNode => ({ kind: 'terminal', nodeId: crypto.randomUUID(), paneId: crypto.randomUUID(), terminalId: null, executionContextId, ...(launchDirectory ? { launchDirectory } : {}) });
const mapLayout = (node: TerminalLayoutNode | null, transform: (node: TerminalLayoutNode) => TerminalLayoutNode): TerminalLayoutNode | null =>
  node && transform(node.kind === 'split' ? { ...node, children: [mapLayout(node.children[0], transform)!, mapLayout(node.children[1], transform)!] } : node);
export function useWorkspaceCompositions(contexts: AlphaExecutionContext[], connections: CompositionConnection[], connectionsLoaded = true) {
  const [presentation, setPresentation] = useState(emptyWorkspacePresentation);
  const [compositions, setCompositions] = useState<Record<string, WorkspaceComposition>>({});
  const [terminals, setTerminals] = useState<Record<string, TerminalSummary[]>>({});
  const [loading, setLoading] = useState(true), [pending, setPending] = useState(false), [error, setError] = useState<string>();
  const state = useRef({ presentation, compositions, terminals, contexts, connections });
  state.current = { presentation, compositions, terminals, contexts, connections };
  const mounted = useRef(true), writes = useRef(Promise.resolve()), saving = useRef(Promise.resolve());
  const load = useRef<Promise<void> | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    load.current = loadWorkspacePresentation().then((value) => { if (mounted.current) { state.current.presentation = value; setPresentation(value); } })
      .catch(() => setError('Could not restore workspace selection.')).finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; };
  }, []);
  const updatePresentation = (update: (value: WorkspacePresentation) => WorkspacePresentation) => {
    const next = update(state.current.presentation);
    state.current.presentation = next; setPresentation(next);
    saving.current = saving.current.catch(() => undefined).then(() => saveWorkspacePresentation(next)).catch(() => { if (mounted.current) setError('Could not save workspace selection.'); });
  };
  useEffect(() => {
    if (loading || !connectionsLoaded) return;
    const known = new Set(connections.map((connection) => connection.hostId));
    const forgotten = state.current.presentation.openWorkspaces.filter((workspace) => !known.has(workspace.hostId));
    if (forgotten.length) updatePresentation((value) => forgotten.reduce((next, workspace) => closeWorkspace(next, workspaceKey(workspace)), value));
  }, [loading, connectionsLoaded, JSON.stringify(connections.map((connection) => connection.hostId))]);
  const remember = (composition: WorkspaceComposition) => {
    if ((state.current.compositions[composition.hostId]?.revision ?? -1) > composition.revision) return;
    const next = { ...state.current.compositions, [composition.hostId]: composition };
    state.current.compositions = next; if (mounted.current) setCompositions(next);
    const reconciled = reconcileWorkspacePresentation(state.current.presentation, composition.hostId, composition.workspaces);
    if (reconciled !== state.current.presentation) updatePresentation(() => reconciled);
    const focusedPanes = { ...state.current.presentation.focusedPanes };
    const maximizedPanes = { ...state.current.presentation.maximizedPanes };
    let changed = false;
    for (const workspace of composition.workspaces) {
      const key = workspaceKey({ hostId: composition.hostId, workspaceId: workspace.workspaceId });
      const panes = terminalPaneTargets([workspace]);
      if (focusedPanes[key] && !panes.some((pane) => pane.paneId === focusedPanes[key])) {
        if (panes[0]) focusedPanes[key] = panes[0].paneId; else delete focusedPanes[key];
        changed = true;
      }
      if (maximizedPanes[key] && !panes.some((pane) => pane.paneId === maximizedPanes[key])) {
        delete maximizedPanes[key]; changed = true;
      }
    }
    if (changed) updatePresentation((value) => ({ ...value, focusedPanes, maximizedPanes }));

  };
  const clientFor = (hostId: string) => {
    const connection = state.current.connections.find((connection) => connection.hostId === hostId);
    if (!connection?.available) throw new PortalTransportError('This Host is unavailable.');
    if (!connection.supported || !connection.client) throw new Error('Update this Host to use Workspaces.');
    return connection.client;
  };
  const refresh = async () => {
    const results = await Promise.allSettled(state.current.connections.map(async (connection) => {
      if (!connection.available || !connection.supported || !connection.client) return;
      const client = connection.client;
      const [{ composition }, records] = await Promise.all([
        client.getWorkspaceComposition(connection.hostId),
        Promise.all(state.current.contexts.filter((context) => context.hostId === connection.hostId).map(async (context) => (await client.listTerminals(context.executionContextId)).terminals)),
      ]);
      if (!mounted.current || !state.current.connections.some((current) => current.client === client && current.available)) return;
      await load.current;
      remember(composition);
      const next = { ...state.current.terminals, [connection.hostId]: records.flat().filter((terminal) => terminal.status === 'running') };
      state.current.terminals = next; setTerminals(next);
    }));
    const failed = results.find((result) => result.status === 'rejected' && !(result.reason instanceof PortalTransportError));
    if (failed?.status === 'rejected' && mounted.current) setError(failed.reason instanceof Error ? failed.reason.message : String(failed.reason));
  };
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => { void refreshRef.current(); const timer = setInterval(() => void refreshRef.current(), 5000); return () => clearInterval(timer); }, [JSON.stringify([contexts.map((context) => context.id), connections.map(({ hostId, available, supported }) => [hostId, available, supported])])]);
  const edit = async (operation: () => Promise<void>) => {
    let success = false;
    const next = writes.current.catch(() => undefined).then(async () => {
      await load.current;
      if (!mounted.current) return;
      setPending(true); setError(undefined);
      try { await operation(); success = true; }
      catch (cause) { await refreshRef.current(); if (mounted.current && !(cause instanceof PortalTransportError)) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (mounted.current) setPending(false); }
    });
    writes.current = next; await next; return success;
  };
  const replace = async (ref: WorkspaceReference, transform: (workspace: Workspace) => Workspace) => {
    const current = state.current.compositions[ref.hostId];
    if (!current?.workspaces.some((workspace) => workspace.workspaceId === ref.workspaceId)) throw new Error('Workspace is unavailable.');
    remember((await clientFor(ref.hostId).replaceWorkspaceComposition(ref.hostId, current.revision, current.workspaces.map((workspace) => workspace.workspaceId === ref.workspaceId ? transform(workspace) : workspace))).composition);
  };
  const editWorkspace = async (ref: WorkspaceReference, transform: (workspace: Workspace) => Workspace) => { await edit(() => replace(ref, transform)); };
  const actions: WorkspaceCompositionActions = {
    open: async (contextId) => { await edit(async () => {
      const context = state.current.contexts.find((context) => context.id === contextId);
      if (!context) throw new Error('Choose an execution directory.');
      const client = clientFor(context.hostId);
      const { composition } = await client.getWorkspaceComposition(context.hostId);
      const workspace = { workspaceId: crypto.randomUUID(), name: context.name, layout: newPane(context.executionContextId) };
      remember((await client.replaceWorkspaceComposition(context.hostId, composition.revision, [...composition.workspaces, workspace])).composition);
      updatePresentation((value) => activateWorkspace(value, { hostId: context.hostId, workspaceId: workspace.workspaceId }));
    }); },
    activate: (ref) => { if (!loading) updatePresentation((value) => activateWorkspace(value, ref)); },
    previewClose: async (ref) => {
      const client = clientFor(ref.hostId);
      if (!client.previewWorkspaceClose) throw new Error('Update this Host to close workspaces.');
      return (await client.previewWorkspaceClose(ref.hostId, ref.workspaceId)).plan;
    },
    close: async (ref, plan, confirmed) => {
      const client = clientFor(ref.hostId);
      if (!client.closeWorkspace) throw new Error('Update this Host to close workspaces.');
      setPending(true);
      try {
        remember((await client.closeWorkspace(ref.hostId, ref.workspaceId, plan.token, confirmed)).composition);
        await refreshRef.current();
      } finally { if (mounted.current) setPending(false); }
    },
    rename: (ref, name) => edit(() => replace(ref, (workspace) => ({ ...workspace, name: name.trim() }))),
    move: (ref, direction) => updatePresentation((value) => {
      const openWorkspaces = [...value.openWorkspaces], index = openWorkspaces.findIndex((workspace) => workspaceKey(workspace) === workspaceKey(ref)), next = index + direction;
      if (index < 0 || next < 0 || next >= openWorkspaces.length) return value;
      [openWorkspaces[index], openWorkspaces[next]] = [openWorkspaces[next]!, openWorkspaces[index]!]; return { ...value, openWorkspaces };
    }),
    split: async (ref, paneId, axis) => { await edit(async () => {
      const workspace = state.current.compositions[ref.hostId]?.workspaces.find((item) => item.workspaceId === ref.workspaceId);
      const source = workspace && terminalPaneTargets([workspace]).find((pane) => pane.paneId === paneId);
      if (!source) throw new Error('Source terminal is unavailable.');
      const records = (await clientFor(ref.hostId).listTerminals(source.executionContextId)).terminals;
      const cwd = records.find((terminal) => terminal.terminalId === source.terminalId)?.currentDirectory;
      const context = state.current.contexts.filter((context) => context.hostId === ref.hostId && context.availability === 'available' && context.canonicalPath && cwd && (cwd === context.canonicalPath || cwd.startsWith(context.canonicalPath === '/' ? '/' : context.canonicalPath + '/'))).sort((a, b) => b.canonicalPath!.length - a.canonicalPath!.length)[0];
      if (cwd && !context) throw new Error('Register the terminal’s current directory before creating a shell there.');
      await replace(ref, (item) => ({ ...item, layout: mapLayout(item.layout, (node) => node.kind === 'terminal' && node.paneId === paneId ? { kind: 'split', nodeId: crypto.randomUUID(), axis, ratio: 0.5, children: [node, newPane(context?.executionContextId ?? source.executionContextId, cwd)] } : node) }));
    }); },
    setRatio: (ref, nodeId, ratio) => editWorkspace(ref, (workspace) => ({ ...workspace, layout: mapLayout(workspace.layout, (node) => node.kind === 'split' && node.nodeId === nodeId ? { ...node, ratio: Math.max(0.1, Math.min(0.9, ratio)) } : node) })),
    addPane: async (ref, contextId) => {
      let paneId: string | undefined;
      const success = await edit(() => replace(ref, (workspace) => {
        const context = state.current.contexts.find((context) => context.id === contextId && context.hostId === ref.hostId);
        if (!context) throw new Error('Choose a directory on this Host.');
        const pane = newPane(context.executionContextId);
        paneId = pane.kind === 'terminal' ? pane.paneId : undefined;
        return { ...workspace, layout: workspace.layout ? { kind: 'split', nodeId: crypto.randomUUID(), axis: 'horizontal', ratio: 0.5, children: [workspace.layout, pane] } : pane };
      }));
      if (success) return paneId;
    },
    focus: (ref, paneId) => updatePresentation((value) => ({ ...activateWorkspace(value, ref), focusedPanes: { ...value.focusedPanes, [workspaceKey(ref)]: paneId }, maximizedPanes: value.maximizedPanes[workspaceKey(ref)] ? { ...value.maximizedPanes, [workspaceKey(ref)]: paneId } : value.maximizedPanes })),
    maximize: (ref, paneId) => updatePresentation((value) => { const maximizedPanes = { ...value.maximizedPanes }; if (maximizedPanes[workspaceKey(ref)] === paneId) delete maximizedPanes[workspaceKey(ref)]; else maximizedPanes[workspaceKey(ref)] = paneId; return { ...value, maximizedPanes }; }),
    collapse: (id) => updatePresentation((value) => ({ ...value, collapsedWorkspaces: value.collapsedWorkspaces.includes(id) ? value.collapsedWorkspaces.filter((item) => item !== id) : [...value.collapsedWorkspaces, id] })),
    refresh,
  };
  return { model: { presentation, compositions, terminals, loading, pending, error }, actions };
}
