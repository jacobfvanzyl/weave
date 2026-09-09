import { Preferences } from '@capacitor/preferences';

export type WorkspaceTabReference = { hostId: string; workspaceId: string; tabId: string };
export type WorkspacePresentation = {
  schemaVersion: 1;
  openTabs: WorkspaceTabReference[];
  recentTabs: string[];
  activeTab?: string;
  focusedPanes: Record<string, string>;
  maximizedPanes: Record<string, string>;
  collapsedContexts: string[];
};
export const tabReferenceKey = (tab: WorkspaceTabReference) => JSON.stringify([tab.hostId, tab.workspaceId, tab.tabId]);
export const workspaceReferenceKey = (hostId: string, workspaceId: string) => JSON.stringify([hostId, workspaceId]);
export const emptyWorkspacePresentation = (): WorkspacePresentation => ({ schemaVersion: 1, openTabs: [], recentTabs: [], focusedPanes: {}, maximizedPanes: {}, collapsedContexts: [] });
const storageKey = 'weave.workspace-presentation.v1';

// Each field is recoverable without clearing unrelated selection or Host credentials.
export function parseWorkspacePresentation(value: string | null): WorkspacePresentation {
  const empty = emptyWorkspacePresentation();
  if (!value) return empty;
  try {
    const input = JSON.parse(value);
    if (input?.schemaVersion !== 1) return empty;
    const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 1000;
    const openTabs = Array.isArray(input.openTabs) ? input.openTabs.filter((tab: WorkspaceTabReference) =>
      tab && validId(tab.hostId) && validId(tab.workspaceId) && validId(tab.tabId)).slice(0, 256) : [];
    const uniqueTabs = [...new Map<string, WorkspaceTabReference>(openTabs.map((tab: WorkspaceTabReference) => [tabReferenceKey(tab), { hostId: tab.hostId, workspaceId: tab.workspaceId, tabId: tab.tabId }])).values()];
    const keys = new Set(uniqueTabs.map(tabReferenceKey));
    const paneMap = (value: unknown): Record<string, string> => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([key, id]) => keys.has(key) && validId(id))) : {};
    return { ...empty, openTabs: uniqueTabs,
      recentTabs: Array.isArray(input.recentTabs) ? [...new Set<string>(input.recentTabs.filter((key: unknown) => typeof key === 'string' && keys.has(key)))] : [],
      activeTab: keys.has(input.activeTab) ? input.activeTab : undefined,
      focusedPanes: paneMap(input.focusedPanes), maximizedPanes: paneMap(input.maximizedPanes),
      collapsedContexts: Array.isArray(input.collapsedContexts) ? input.collapsedContexts.filter(validId).slice(0, 256) : [],
    };
  } catch { return empty; }
}
export async function loadWorkspacePresentation() {
  return parseWorkspacePresentation((await Preferences.get({ key: storageKey })).value);
}
export async function saveWorkspacePresentation(state: WorkspacePresentation) {
  await Preferences.set({ key: storageKey, value: JSON.stringify(state) });
}
export function activateWorkspaceTab(state: WorkspacePresentation, tab: WorkspaceTabReference): WorkspacePresentation {
  const key = tabReferenceKey(tab);
  return { ...state,
    openTabs: state.openTabs.some((item) => tabReferenceKey(item) === key) ? state.openTabs : [...state.openTabs, tab],
    activeTab: key, recentTabs: [key, ...state.recentTabs.filter((item) => item !== key)],
  };
}
export function closeWorkspaceTab(state: WorkspacePresentation, key: string): WorkspacePresentation {
  const openTabs = state.openTabs.filter((tab) => tabReferenceKey(tab) !== key);
  const recentTabs = state.recentTabs.filter((item) => item !== key);
  return { ...state, openTabs, recentTabs, activeTab: state.activeTab === key ? recentTabs[0] : state.activeTab };
}
