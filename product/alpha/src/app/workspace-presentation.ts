import { Preferences } from '@capacitor/preferences';

export type WorkspaceReference = { hostId: string; workspaceId: string };
export type WorkspacePresentation = {
  schemaVersion: 2;
  openWorkspaces: WorkspaceReference[];
  recentWorkspaces: string[];
  activeWorkspace?: string;
  focusedPanes: Record<string, string>;
  maximizedPanes: Record<string, string>;
  collapsedWorkspaces: string[];
  knownRecoveryWorkspaces?: string[];
};
export const workspaceKey = (tab: WorkspaceReference) => JSON.stringify([tab.hostId, tab.workspaceId]);
export const hostCompositionKey = (hostId: string) => hostId;
export const emptyWorkspacePresentation = (): WorkspacePresentation => ({ schemaVersion: 2, openWorkspaces: [], recentWorkspaces: [], focusedPanes: {}, maximizedPanes: {}, collapsedWorkspaces: [] });
const storageKey = 'weave.workspace-presentation.v2';

// Each field is recoverable without clearing unrelated selection or Host credentials.
export function parseWorkspacePresentation(value: string | null): WorkspacePresentation {
  const empty = emptyWorkspacePresentation();
  if (!value) return empty;
  try {
    const input = JSON.parse(value);
    if (input?.schemaVersion === 1) {
      const key = (value: string) => { try { const parts = JSON.parse(value); return JSON.stringify([parts[0], parts[2]]); } catch { return ''; } };
      input.openWorkspaces = (input.openTabs ?? []).map((tab: any) => ({ hostId: tab.hostId, workspaceId: tab.tabId }));
      input.recentWorkspaces = (input.recentTabs ?? []).map(key);
      input.activeWorkspace = input.activeTab ? key(input.activeTab) : undefined;
      for (const field of ['focusedPanes', 'maximizedPanes']) input[field] = Object.fromEntries(Object.entries(input[field] ?? {}).map(([old, pane]) => [key(old), pane]));
      input.collapsedWorkspaces = [];
      input.schemaVersion = 2;
    }
    if (input?.schemaVersion !== 2) return empty;
    const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 1000;
    const openWorkspaces = Array.isArray(input.openWorkspaces) ? input.openWorkspaces.filter((tab: WorkspaceReference) =>
      tab && validId(tab.hostId) && validId(tab.workspaceId)).slice(0, 256) : [];
    const uniqueTabs = [...new Map<string, WorkspaceReference>(openWorkspaces.map((tab: WorkspaceReference) => [workspaceKey(tab), { hostId: tab.hostId, workspaceId: tab.workspaceId }])).values()];
    const keys = new Set(uniqueTabs.map(workspaceKey));
    const paneMap = (value: unknown): Record<string, string> => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([key, id]) => keys.has(key) && validId(id))) : {};
    return { ...empty, openWorkspaces: uniqueTabs,
      recentWorkspaces: Array.isArray(input.recentWorkspaces) ? [...new Set<string>(input.recentWorkspaces.filter((key: unknown) => typeof key === 'string' && keys.has(key)))] : [],
      activeWorkspace: keys.has(input.activeWorkspace) ? input.activeWorkspace : undefined,
      focusedPanes: paneMap(input.focusedPanes), maximizedPanes: paneMap(input.maximizedPanes),
      knownRecoveryWorkspaces: Array.isArray(input.knownRecoveryWorkspaces) ? input.knownRecoveryWorkspaces.filter(validId) : [],
      collapsedWorkspaces: Array.isArray(input.collapsedWorkspaces) ? input.collapsedWorkspaces.filter(validId).slice(0, 256) : [],
    };
  } catch { return empty; }
}
export async function loadWorkspacePresentation() {
  const current = (await Preferences.get({ key: storageKey })).value;
  return parseWorkspacePresentation(current ?? (await Preferences.get({ key: 'weave.workspace-presentation.v1' })).value);
}
export async function saveWorkspacePresentation(state: WorkspacePresentation) {
  await Preferences.set({ key: storageKey, value: JSON.stringify(state) });
}
export function activateWorkspace(state: WorkspacePresentation, tab: WorkspaceReference): WorkspacePresentation {
  const key = workspaceKey(tab);
  return { ...state,
    openWorkspaces: state.openWorkspaces.some((item) => workspaceKey(item) === key) ? state.openWorkspaces : [...state.openWorkspaces, tab],
    activeWorkspace: key, recentWorkspaces: [key, ...state.recentWorkspaces.filter((item) => item !== key)],
  };
}
export function closeWorkspace(state: WorkspacePresentation, key: string): WorkspacePresentation {
  const openWorkspaces = state.openWorkspaces.filter((tab) => workspaceKey(tab) !== key);
  const recentWorkspaces = state.recentWorkspaces.filter((item) => item !== key);
  return { ...state, openWorkspaces, recentWorkspaces, activeWorkspace: state.activeWorkspace === key ? recentWorkspaces[0] : state.activeWorkspace };
}

export function showWorkspaceHostIdentity(connections: { hostId: string }[], compositions: Record<string, { workspaces: unknown[] }>, presentation: WorkspacePresentation) {
  const hosts = new Set(connections.filter(({ hostId }) => compositions[hostId]?.workspaces.length).map(({ hostId }) => hostId));
  for (const ref of presentation.openWorkspaces) if (!compositions[ref.hostId] && connections.some(({ hostId }) => hostId === ref.hostId)) hosts.add(ref.hostId);
  return hosts.size > 1;
}

// Every Host workspace is visible on every connected device. Preserve local
// selection/order, but reconcile membership from the authoritative composition.
export function reconcileWorkspacePresentation(state: WorkspacePresentation, hostId: string, workspaces: { workspaceId: string }[]): WorkspacePresentation {
  const valid = new Set(workspaces.map(({ workspaceId }) => workspaceKey({ hostId, workspaceId })));
  let next = state;
  for (const ref of state.openWorkspaces) if (ref.hostId === hostId && !valid.has(workspaceKey(ref))) next = closeWorkspace(next, workspaceKey(ref));
  const present = new Set(next.openWorkspaces.map(workspaceKey));
  const missing = workspaces.filter(({ workspaceId }) => !present.has(workspaceKey({ hostId, workspaceId })));
  const active = next.activeWorkspace;
  for (const { workspaceId } of missing) next = activateWorkspace(next, { hostId, workspaceId });
  return next === state ? state : { ...next, activeWorkspace: active ?? next.activeWorkspace };
}
