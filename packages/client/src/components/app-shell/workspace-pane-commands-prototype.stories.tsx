// PROTOTYPE — three command surfaces for the accepted Workbench model, switchable with ?variant=A|B|C.
// This Storybook-only artifact answers PER-15; it is not production shell code.
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  Command,
  FileCode2,
  Files,
  GripVertical,
  Keyboard,
  LayoutGrid,
  Maximize2,
  Menu,
  MessageSquare,
  Minus,
  MousePointer2,
  Move,
  PanelTop,
  Pencil,
  Plus,
  Replace,
  Search,
  SquareTerminal,
  X,
} from 'lucide-react';

import { cn } from '../../lib/cn';
import { Button } from '../ui/button';

type PaneKind = 'thread' | 'editor' | 'terminal';
type VariantKey = 'A' | 'B' | 'C';
type PaneDirection = 'left' | 'right' | 'up' | 'down';

type PaneModel = {
  id: string;
  kind: PaneKind;
  title: string;
  subtitle: string;
  weight: number;
};

type WorkspaceTabModel = {
  id: string;
  name: string;
  panes: PaneModel[];
  preferredEditorPaneId?: string;
};

type CommandItem = {
  id: string;
  group: 'Pane' | 'Workspace Tab' | 'Workbench';
  label: string;
  shortcut?: string;
  detail: string;
  run: () => void;
};

const variants: Array<{ key: VariantKey; name: string; summary: string }> = [
  { key: 'A', name: 'Local controls', summary: 'Direct manipulation first, command palette everywhere' },
  { key: 'B', name: 'Command deck', summary: 'Keyboard and named commands first, quiet Pane chrome' },
  { key: 'C', name: 'Arrange mode', summary: 'Explicit layout editing mode, content stays calm by default' },
];

const paneNames: Record<PaneKind, string> = {
  thread: 'Thread Pane',
  editor: 'Editor Pane',
  terminal: 'Terminal Pane',
};

const initialTabs: WorkspaceTabModel[] = [
  {
    id: 'review',
    name: 'Agent review',
    preferredEditorPaneId: 'editor-shell',
    panes: [
      { id: 'thread-per-15', kind: 'thread', title: 'Define Pane commands', subtitle: 'Running · 1m 18s', weight: 1.25 },
      { id: 'editor-shell', kind: 'editor', title: 'workspace-shell.tsx', subtitle: 'packages/client/src', weight: 1 },
      { id: 'terminal-dev', kind: 'terminal', title: 'storybook', subtitle: 'bun run storybook', weight: 0.8 },
    ],
  },
  {
    id: 'build',
    name: 'Desktop build',
    preferredEditorPaneId: 'editor-rpc',
    panes: [
      { id: 'editor-rpc', kind: 'editor', title: 'rpc-connection.ts', subtitle: 'desktop/src/main', weight: 1.2 },
      { id: 'terminal-test', kind: 'terminal', title: 'client tests', subtitle: 'bun test', weight: 0.8 },
    ],
  },
  { id: 'notes', name: 'Architecture notes', panes: [] },
];

const paneIcon = (kind: PaneKind, size = 14) => {
  if (kind === 'thread') return <MessageSquare size={size} />;
  if (kind === 'terminal') return <SquareTerminal size={size} />;
  return <FileCode2 size={size} />;
};

const makePane = (kind: PaneKind, serial: number): PaneModel => {
  if (kind === 'thread') return { id: 'thread-per-15', kind, title: 'Define Pane commands', subtitle: 'Running · 1m 18s', weight: 1 };
  if (kind === 'terminal') return { id: `terminal-${serial}`, kind, title: 'Terminal', subtitle: 'zsh · weave', weight: 1 };
  return { id: `editor-${serial}`, kind, title: 'Untitled preview', subtitle: 'Choose a file from Files', weight: 1 };
};

const neighborIndex = (index: number, count: number, direction: PaneDirection) => {
  const column = index % 2;
  if (direction === 'left') return column === 1 ? index - 1 : -1;
  if (direction === 'right') return column === 0 && index + 1 < count ? index + 1 : -1;
  if (direction === 'up') return index - 2;
  return index + 2 < count ? index + 2 : -1;
};

const usePrototypeState = () => {
  const [tabs, setTabs] = useState(initialTabs);
  const [activeTabId, setActiveTabId] = useState('review');
  const [activePaneId, setActivePaneId] = useState('thread-per-15');
  const [maximizedPaneId, setMaximizedPaneId] = useState<string>();
  const [workspaceDefaultPaneKind, setWorkspaceDefaultPaneKindState] = useState<PaneKind>('editor');
  const [serial, setSerial] = useState(1);
  const [lastAction, setLastAction] = useState('Ready — every action is reflected here.');

  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? tabs[0];
  const activePane = activeTab.panes.find(pane => pane.id === activePaneId) ?? activeTab.panes[0];

  const updateActiveTab = (update: (tab: WorkspaceTabModel) => WorkspaceTabModel) => {
    setTabs(current => current.map(tab => tab.id === activeTabId ? update(tab) : tab));
  };

  const selectTab = (tabId: string) => {
    const tab = tabs.find(candidate => candidate.id === tabId);
    if (!tab) return;
    setActiveTabId(tab.id);
    setActivePaneId(tab.panes[0]?.id ?? '');
    setMaximizedPaneId(undefined);
    setLastAction(`Switched to Workspace Tab “${tab.name}” and restored its Pane arrangement.`);
  };

  const focusPane = (paneId: string) => {
    const pane = activeTab.panes.find(candidate => candidate.id === paneId);
    if (!pane) return;
    setActivePaneId(pane.id);
    setLastAction(`Focused ${paneNames[pane.kind]} “${pane.title}”.`);
  };

  const focusDirectionalPane = (direction: PaneDirection) => {
    if (!activePane) return;
    const index = activeTab.panes.findIndex(pane => pane.id === activePane.id);
    const target = activeTab.panes[neighborIndex(index, activeTab.panes.length, direction)];
    if (!target) {
      setLastAction(`“${activePane.title}” has no Pane ${direction === 'up' ? 'above' : direction === 'down' ? 'below' : `to its ${direction}`}.`);
      return;
    }
    setActivePaneId(target.id);
    setLastAction(`Focused the ${paneNames[target.kind]} ${direction === 'up' ? 'above' : direction === 'down' ? 'below' : `to the ${direction}`}: “${target.title}”.`);
  };

  const activateThread = () => {
    const owner = tabs.find(tab => tab.panes.some(pane => pane.id === 'thread-per-15'));
    if (!owner) {
      const next = makePane('thread', serial);
      updateActiveTab(tab => ({ ...tab, panes: [...tab.panes, next] }));
      setSerial(value => value + 1);
      setActivePaneId(next.id);
      setLastAction('Opened the Thread in a new Thread Pane in the active Workspace Tab.');
      return;
    }
    setActiveTabId(owner.id);
    setActivePaneId('thread-per-15');
    setMaximizedPaneId(undefined);
    setLastAction(`Activated the Thread’s existing Pane in “${owner.name}”; no duplicate was created.`);
  };

  const newPane = (kind: PaneKind) => {
    if (kind === 'thread') {
      activateThread();
      return;
    }
    const next = makePane(kind, serial);
    setSerial(value => value + 1);
    updateActiveTab(tab => ({
      ...tab,
      panes: [...tab.panes, next],
      preferredEditorPaneId: kind === 'editor' && !tab.preferredEditorPaneId ? next.id : tab.preferredEditorPaneId,
    }));
    setActivePaneId(next.id);
    setLastAction(`Created a new ${paneNames[kind]} at the end of “${activeTab.name}”.`);
  };

  const splitPane = (direction: 'right' | 'down', kind: PaneKind = 'editor') => {
    if (kind === 'thread') {
      activateThread();
      return;
    }
    const next = makePane(kind, serial);
    const activeIndex = activeTab.panes.findIndex(pane => pane.id === activePane?.id);
    setSerial(value => value + 1);
    updateActiveTab(tab => {
      const panes = [...tab.panes];
      const insertionIndex = direction === 'right' ? activeIndex + 1 : activeIndex + 2;
      panes.splice(Math.min(panes.length, Math.max(0, insertionIndex)), 0, next);
      return {
        ...tab,
        panes,
        preferredEditorPaneId: kind === 'editor' && !tab.preferredEditorPaneId ? next.id : tab.preferredEditorPaneId,
      };
    });
    setActivePaneId(next.id);
    setLastAction(`Split ${direction === 'right' ? 'right from' : 'below'} “${activePane?.title ?? 'the canvas'}” with a ${paneNames[kind]}.`);
  };

  const closePane = (paneId = activePane?.id) => {
    if (!paneId) return;
    const index = activeTab.panes.findIndex(pane => pane.id === paneId);
    const pane = activeTab.panes[index];
    if (!pane) return;
    const remaining = activeTab.panes.filter(candidate => candidate.id !== paneId);
    updateActiveTab(tab => ({
      ...tab,
      panes: remaining,
      preferredEditorPaneId: tab.preferredEditorPaneId === paneId
        ? remaining.find(candidate => candidate.kind === 'editor')?.id
        : tab.preferredEditorPaneId,
    }));
    if (activePaneId === paneId) setActivePaneId(remaining[Math.min(index, remaining.length - 1)]?.id ?? '');
    if (maximizedPaneId === paneId) setMaximizedPaneId(undefined);
    setLastAction(`Closed ${paneNames[pane.kind]} “${pane.title}”; its Workspace Tab remains open.`);
  };

  const replacePane = (kind: PaneKind) => {
    if (!activePane) return;
    if (kind === 'thread') {
      activateThread();
      setLastAction('Replace with Thread resolved to the Thread’s existing Pane instead of creating a duplicate.');
      return;
    }
    const replacement = { ...makePane(kind, serial), id: activePane.id, weight: activePane.weight };
    setSerial(value => value + 1);
    updateActiveTab(tab => ({
      ...tab,
      panes: tab.panes.map(pane => pane.id === activePane.id ? replacement : pane),
      preferredEditorPaneId: kind === 'editor' ? replacement.id : tab.preferredEditorPaneId === activePane.id ? undefined : tab.preferredEditorPaneId,
    }));
    setLastAction(`Replaced “${activePane.title}” in place with a ${paneNames[kind]}.`);
  };

  const movePane = (direction: PaneDirection) => {
    if (!activePane) return;
    const index = activeTab.panes.findIndex(pane => pane.id === activePane.id);
    const target = neighborIndex(index, activeTab.panes.length, direction);
    if (target < 0) {
      setLastAction(`“${activePane.title}” has no Pane ${direction === 'up' ? 'above' : direction === 'down' ? 'below' : `to its ${direction}`} to swap with.`);
      return;
    }
    updateActiveTab(tab => {
      const panes = [...tab.panes];
      [panes[index], panes[target]] = [panes[target], panes[index]];
      return { ...tab, panes };
    });
    setLastAction(`Moved “${activePane.title}” ${direction === 'up' ? 'above' : direction === 'down' ? 'below' : `to the ${direction} of`} its neighbor; the layout slots stayed in place.`);
  };

  const setWorkspaceDefaultPaneKind = (kind: PaneKind) => {
    setWorkspaceDefaultPaneKindState(kind);
    setLastAction(`${paneNames[kind]} is now the New Pane default for this Workspace.`);
  };

  const movePaneToTab = (targetTabId: string) => {
    if (!activePane || targetTabId === activeTabId) return;
    const target = tabs.find(tab => tab.id === targetTabId);
    if (!target) return;
    const sourceTabId = activeTabId;
    setTabs(current => current.map(tab => {
      if (tab.id === sourceTabId) return {
        ...tab,
        panes: tab.panes.filter(pane => pane.id !== activePane.id),
        preferredEditorPaneId: tab.preferredEditorPaneId === activePane.id ? undefined : tab.preferredEditorPaneId,
      };
      if (tab.id === targetTabId) return {
        ...tab,
        panes: [...tab.panes, activePane],
        preferredEditorPaneId: activePane.kind === 'editor' && !tab.preferredEditorPaneId ? activePane.id : tab.preferredEditorPaneId,
      };
      return tab;
    }));
    setActiveTabId(targetTabId);
    setActivePaneId(activePane.id);
    setMaximizedPaneId(undefined);
    setLastAction(`Moved “${activePane.title}” to Workspace Tab “${target.name}” and followed it.`);
  };

  const resizePane = (delta: number) => {
    if (!activePane) return;
    const weight = Math.min(1.8, Math.max(0.55, activePane.weight + delta));
    updateActiveTab(tab => ({ ...tab, panes: tab.panes.map(pane => pane.id === activePane.id ? { ...pane, weight } : pane) }));
    setLastAction(`Resized “${activePane.title}” to ${Math.round(weight * 100)}% relative weight.`);
  };

  const toggleMaximize = () => {
    if (!activePane) return;
    const next = maximizedPaneId === activePane.id ? undefined : activePane.id;
    setMaximizedPaneId(next);
    setLastAction(next ? `Maximized “${activePane.title}” within this Workspace Tab.` : `Restored the full Pane arrangement in “${activeTab.name}”.`);
  };

  const createTab = () => {
    const id = `tab-${serial}`;
    const next = { id, name: `Workspace Tab ${tabs.length + 1}`, panes: [] };
    setSerial(value => value + 1);
    setTabs(current => [...current, next]);
    setActiveTabId(id);
    setActivePaneId('');
    setMaximizedPaneId(undefined);
    setLastAction(`Created “${next.name}”. It persists until explicitly closed.`);
  };

  const renameTab = (tabId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setTabs(current => current.map(tab => tab.id === tabId ? { ...tab, name: trimmed } : tab));
    setLastAction(`Renamed the Workspace Tab to “${trimmed}”.`);
  };

  const moveTab = (direction: -1 | 1) => {
    const index = tabs.findIndex(tab => tab.id === activeTabId);
    const target = index + direction;
    if (target < 0 || target >= tabs.length) return;
    const next = [...tabs];
    [next[index], next[target]] = [next[target], next[index]];
    setTabs(next);
    setLastAction(`Moved Workspace Tab “${activeTab.name}” ${direction < 0 ? 'left' : 'right'}.`);
  };

  const closeTab = (tabId = activeTabId) => {
    if (tabs.length === 1) {
      setLastAction('The final Workspace Tab stays open; close its Panes to leave an empty canvas.');
      return;
    }
    const index = tabs.findIndex(tab => tab.id === tabId);
    const closing = tabs[index];
    const remaining = tabs.filter(tab => tab.id !== tabId);
    const next = remaining[Math.min(index, remaining.length - 1)];
    setTabs(remaining);
    if (tabId === activeTabId) {
      setActiveTabId(next.id);
      setActivePaneId(next.panes[0]?.id ?? '');
      setMaximizedPaneId(undefined);
    }
    setLastAction(`Closed Workspace Tab “${closing.name}” and its Pane arrangement.`);
  };

  const openFile = (path: string) => {
    const title = path.split('/').pop() ?? path;
    const preferred = activeTab.panes.find(pane => pane.id === activeTab.preferredEditorPaneId && pane.kind === 'editor');
    if (preferred) {
      updateActiveTab(tab => ({ ...tab, panes: tab.panes.map(pane => pane.id === preferred.id ? { ...pane, title, subtitle: path } : pane) }));
      setActivePaneId(preferred.id);
      setLastAction(`Previewed “${path}” in this Tab’s preferred Editor Pane.`);
      return;
    }
    const next = { ...makePane('editor', serial), title, subtitle: path };
    setSerial(value => value + 1);
    updateActiveTab(tab => ({ ...tab, panes: [...tab.panes, next], preferredEditorPaneId: next.id }));
    setActivePaneId(next.id);
    setLastAction(`Created a preferred Editor Pane in “${activeTab.name}” and previewed “${path}”.`);
  };

  const preferEditor = () => {
    if (!activePane || activePane.kind !== 'editor') return;
    updateActiveTab(tab => ({ ...tab, preferredEditorPaneId: activePane.id }));
    setLastAction(`“${activePane.title}” is now this Workspace Tab’s preferred Editor Pane.`);
  };

  return {
    activePane,
    activePaneId,
    activeTab,
    activeTabId,
    activateThread,
    closePane,
    closeTab,
    createTab,
    focusPane,
    focusDirectionalPane,
    lastAction,
    maximizedPaneId,
    movePane,
    movePaneToTab,
    moveTab,
    newPane,
    openFile,
    preferEditor,
    renameTab,
    replacePane,
    resizePane,
    selectTab,
    setWorkspaceDefaultPaneKind,
    splitPane,
    tabs,
    toggleMaximize,
    workspaceDefaultPaneKind,
  };
};

type PrototypeState = ReturnType<typeof usePrototypeState>;

const useCommands = (state: PrototypeState): CommandItem[] => useMemo(() => [
  { id: 'new-pane', group: 'Pane', label: `New Pane (${paneNames[state.workspaceDefaultPaneKind]})`, detail: 'Create the active Workspace’s default Pane type in the active Tab.', run: () => state.newPane(state.workspaceDefaultPaneKind) },
  { id: 'split-right', group: 'Pane', label: 'Split Pane Right', shortcut: '⌘\\', detail: 'Create an Editor Pane beside the focused Pane.', run: () => state.splitPane('right', 'editor') },
  { id: 'split-down', group: 'Pane', label: 'Split Pane Below', shortcut: '⌘⇧\\', detail: 'Create a Terminal Pane below the focused Pane.', run: () => state.splitPane('down', 'terminal') },
  { id: 'focus-left', group: 'Pane', label: 'Focus Pane Left', shortcut: '⌥←', detail: 'Focus the spatial neighbor to the left.', run: () => state.focusDirectionalPane('left') },
  { id: 'focus-right', group: 'Pane', label: 'Focus Pane Right', shortcut: '⌥→', detail: 'Focus the spatial neighbor to the right.', run: () => state.focusDirectionalPane('right') },
  { id: 'focus-up', group: 'Pane', label: 'Focus Pane Above', shortcut: '⌥↑', detail: 'Focus the spatial neighbor above.', run: () => state.focusDirectionalPane('up') },
  { id: 'focus-down', group: 'Pane', label: 'Focus Pane Below', shortcut: '⌥↓', detail: 'Focus the spatial neighbor below.', run: () => state.focusDirectionalPane('down') },
  { id: 'move-left', group: 'Pane', label: 'Move Pane Left', shortcut: '⌥⇧←', detail: 'Swap the focused Pane with its left neighbor.', run: () => state.movePane('left') },
  { id: 'move-right', group: 'Pane', label: 'Move Pane Right', shortcut: '⌥⇧→', detail: 'Swap the focused Pane with its right neighbor.', run: () => state.movePane('right') },
  { id: 'move-up', group: 'Pane', label: 'Move Pane Above', shortcut: '⌥⇧↑', detail: 'Swap the focused Pane with its neighbor above.', run: () => state.movePane('up') },
  { id: 'move-down', group: 'Pane', label: 'Move Pane Below', shortcut: '⌥⇧↓', detail: 'Swap the focused Pane with its neighbor below.', run: () => state.movePane('down') },
  { id: 'maximize', group: 'Pane', label: state.maximizedPaneId ? 'Restore Pane Arrangement' : 'Maximize Pane', shortcut: '⌘⇧M', detail: 'Temporarily show only the focused Pane inside its Tab.', run: state.toggleMaximize },
  { id: 'replace-editor', group: 'Pane', label: 'Replace Pane with Editor', detail: 'Keep the slot and replace its presented Pane type.', run: () => state.replacePane('editor') },
  { id: 'close-pane', group: 'Pane', label: 'Close Pane', shortcut: '⌘W', detail: 'Close the Pane, not its Thread, Terminal session, or Workspace Tab.', run: () => state.closePane() },
  { id: 'new-tab', group: 'Workspace Tab', label: 'New Workspace Tab', shortcut: '⌘T', detail: 'Create a persistent empty Pane arrangement.', run: state.createTab },
  { id: 'move-tab-left', group: 'Workspace Tab', label: 'Move Workspace Tab Left', detail: 'Reorder the active Workspace Tab.', run: () => state.moveTab(-1) },
  { id: 'move-tab-right', group: 'Workspace Tab', label: 'Move Workspace Tab Right', detail: 'Reorder the active Workspace Tab.', run: () => state.moveTab(1) },
  { id: 'close-tab', group: 'Workspace Tab', label: 'Close Workspace Tab', shortcut: '⌘⇧W', detail: 'Close the Tab and its Pane arrangement after confirmation when needed.', run: () => state.closeTab() },
  { id: 'activate-thread', group: 'Workbench', label: 'Activate Thread Pane', shortcut: '⌘⇧J', detail: 'Find and focus the Thread’s unique open Pane across Workspace Tabs.', run: state.activateThread },
], [state]);

const PaneBody = ({ pane }: { pane: PaneModel }) => {
  if (pane.kind === 'thread') return (
    <div className="space-y-3 p-4 text-sm">
      <div className="max-w-[82%] rounded-xl rounded-tl-sm bg-muted px-3 py-2">Keep manipulation directly on the focused Pane, with commands and keybindings available everywhere.</div>
      <div className="ml-auto max-w-[86%] rounded-xl rounded-tr-sm bg-primary px-3 py-2 text-primary-foreground">Borrow tmux’s split-tree geometry: directional movement swaps the Pane with its adjacent layout cell.</div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Bot size={14} /> Testing directional split and move semantics…</div>
    </div>
  );
  if (pane.kind === 'terminal') return (
    <div className="h-full bg-[#111318] p-4 font-mono text-xs leading-6 text-[#d7dae0]">
      <p><span className="text-[#8bd5ca]">weave</span> <span className="text-[#a6da95]">prototype*</span> bun run storybook</p>
      <p className="text-[#8aadf4]">Local: http://localhost:6006</p>
      <p className="text-[#939ab7]">Storybook ready · accessibility enabled</p>
      <p className="mt-2 animate-pulse">▋</p>
    </div>
  );
  return (
    <div className="grid h-full grid-cols-[auto_1fr] bg-background font-mono text-xs leading-6">
      <div className="select-none border-r border-border bg-muted/30 px-3 text-right text-muted-foreground">{[1, 2, 3, 4, 5, 6, 7, 8].map(line => <div key={line}>{line}</div>)}</div>
      <pre className="overflow-hidden p-3 text-foreground"><code><span className="text-chart-4">type</span> PaneCommand = {'{'}{`\n`}  label: string;{`\n`}  target: PaneId;{`\n`}  source: 'pointer' | 'keyboard' | 'palette';{`\n`}{'}'};{`\n\n`}<span className="text-muted-foreground">// One command vocabulary, many access paths.</span></code></pre>
    </div>
  );
};

const WorkspaceTabs = ({ compact = false, state }: { compact?: boolean; state: PrototypeState }) => {
  const [renaming, setRenaming] = useState<string>();
  const [newPaneMenuOpen, setNewPaneMenuOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const beginRename = (tab: WorkspaceTabModel) => {
    setRenaming(tab.id);
    setDraft(tab.name);
  };
  const save = () => {
    if (renaming) state.renameTab(renaming, draft);
    setRenaming(undefined);
  };
  return (
    <div className="relative flex min-w-0 items-end gap-0.5 border-b border-border bg-muted/25 px-2 pt-2" aria-label="Workspace Tabs">
      {state.tabs.map(tab => (
        <div key={tab.id} className={cn('group flex h-9 max-w-56 items-center gap-1 rounded-t-md border border-b-0 px-2 text-xs', tab.id === state.activeTabId ? 'border-border bg-background text-foreground' : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground')}>
          <button className="flex min-w-0 flex-1 items-center gap-2" onClick={() => state.selectTab(tab.id)} onDoubleClick={() => beginRename(tab)}>
            <LayoutGrid size={13} /><span className="truncate">{tab.name}</span><span className="rounded bg-muted px-1 text-[10px]">{tab.panes.length}</span>
          </button>
          {!compact && tab.id === state.activeTabId ? <Button size="icon-xs" variant="ghost" aria-label={`New Pane in ${tab.name}`} onClick={() => setNewPaneMenuOpen(value => !value)}><Plus size={11} /></Button> : null}
          {!compact ? <Button size="icon-xs" variant="ghost" aria-label={`Rename Workspace Tab ${tab.name}`} onClick={() => beginRename(tab)}><Pencil size={11} /></Button> : null}
          {!compact ? <Button size="icon-xs" variant="ghost" aria-label={`Close Workspace Tab ${tab.name}`} onClick={() => state.closeTab(tab.id)}><X size={11} /></Button> : null}
        </div>
      ))}
      <Button size="icon-sm" variant="ghost" aria-label="New Workspace Tab" onClick={state.createTab}><Plus size={14} /></Button>
      {newPaneMenuOpen ? (
        <div role="dialog" aria-label="New Pane" className="absolute left-2 top-11 z-40 w-72 rounded-lg border border-border bg-popover p-2 shadow-xl">
          <div className="px-2 pb-2 pt-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">New Pane in {state.activeTab.name}</div>
          {(['thread', 'editor', 'terminal'] as PaneKind[]).map(kind => (
            <button key={kind} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted" onClick={() => { state.newPane(kind); setNewPaneMenuOpen(false); }}>
              {paneIcon(kind, 13)}<span className="min-w-0 flex-1 text-xs">{paneNames[kind]}</span>{state.workspaceDefaultPaneKind === kind ? <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">Workspace default</span> : null}
            </button>
          ))}
          <label className="mt-2 flex items-center gap-2 border-t border-border px-2 pt-2 text-[10px] text-muted-foreground">Default for this Workspace
            <select aria-label="Default Pane type for this Workspace" className="ml-auto rounded border border-border bg-background px-2 py-1 text-[10px] text-foreground" value={state.workspaceDefaultPaneKind} onChange={event => state.setWorkspaceDefaultPaneKind(event.target.value as PaneKind)}>
              <option value="thread">Thread Pane</option><option value="editor">Editor Pane</option><option value="terminal">Terminal Pane</option>
            </select>
          </label>
        </div>
      ) : null}
      {renaming ? (
        <div className="absolute left-1/2 top-16 z-40 flex -translate-x-1/2 items-center gap-2 rounded-md border border-border bg-popover p-2 shadow-xl">
          <label className="text-xs">Rename Workspace Tab <input autoFocus className="ml-2 rounded border border-border bg-background px-2 py-1" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') save(); if (event.key === 'Escape') setRenaming(undefined); }} /></label>
          <Button size="sm" onClick={save}>Save</Button>
        </div>
      ) : null}
    </div>
  );
};

const PaneCanvas = ({ chrome, state }: { chrome: 'local' | 'quiet' | 'arrange'; state: PrototypeState }) => {
  const panes = state.maximizedPaneId ? state.activeTab.panes.filter(pane => pane.id === state.maximizedPaneId) : state.activeTab.panes;
  if (!panes.length) return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 border border-dashed border-border bg-muted/10 text-center">
      <LayoutGrid size={30} className="text-muted-foreground" />
      <div><div className="text-sm font-medium">This Workspace Tab has no Panes</div><div className="mt-1 text-xs text-muted-foreground">Create a root Pane; split commands appear after it exists.</div></div>
      <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => state.newPane('thread')}>Thread Pane</Button><Button size="sm" variant="outline" onClick={() => state.newPane('editor')}>Editor Pane</Button><Button size="sm" variant="outline" onClick={() => state.newPane('terminal')}>Terminal Pane</Button></div>
    </div>
  );
  return (
    <div className="grid min-h-0 flex-1 gap-2 bg-muted/10 p-2" style={{ gridTemplateColumns: `repeat(${Math.min(2, panes.length)}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(panes.length / 2)}, minmax(0, 1fr))` }} aria-label="Pane arrangement">
      {panes.map((pane, index) => {
        const active = pane.id === state.activePaneId;
        return (
          <section key={pane.id} className={cn('relative flex min-h-0 min-w-40 flex-col overflow-hidden rounded-md border bg-background shadow-sm', active ? 'border-primary/70 ring-1 ring-primary/30' : 'border-border', chrome === 'arrange' && 'border-dashed border-primary/60')} onClick={() => state.focusPane(pane.id)}>
            {chrome === 'arrange' ? <div className="absolute left-2 top-11 z-10 flex size-6 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">{index + 1}</div> : null}
            <header className={cn('flex h-10 shrink-0 items-center gap-2 border-b px-2', active ? 'border-primary/30 bg-primary/5' : 'border-border bg-muted/25')}>
              {chrome === 'arrange' ? <GripVertical size={14} className="text-primary" /> : null}
              <span className={cn('text-muted-foreground', active && 'text-primary')}>{paneIcon(pane.kind)}</span>
              <div className="min-w-0 flex-1"><div className="truncate text-xs font-medium">{pane.title}</div><div className="truncate text-[10px] text-muted-foreground">{paneNames[pane.kind]} · {pane.subtitle}</div></div>
              {chrome === 'local' && active ? (
                <div className="flex items-center">
                  <Button size="icon-xs" variant="ghost" aria-label={`Split right from ${pane.title}`} onClick={event => { event.stopPropagation(); state.focusPane(pane.id); state.splitPane('right', 'editor'); }}><PanelTop className="rotate-90" size={12} /></Button>
                  <Button size="icon-xs" variant="ghost" aria-label={`Split below ${pane.title}`} onClick={event => { event.stopPropagation(); state.focusPane(pane.id); state.splitPane('down', 'terminal'); }}><PanelTop size={12} /></Button>
                  <Button size="icon-xs" variant="ghost" aria-label={state.maximizedPaneId ? 'Restore Pane arrangement' : `Maximize ${pane.title}`} onClick={event => { event.stopPropagation(); state.focusPane(pane.id); state.toggleMaximize(); }}><Maximize2 size={12} /></Button>
                  <Button size="icon-xs" variant="ghost" aria-label={`Move ${pane.title} left`} onClick={event => { event.stopPropagation(); state.movePane('left'); }}><ArrowLeft size={12} /></Button>
                  <Button size="icon-xs" variant="ghost" aria-label={`Move ${pane.title} right`} onClick={event => { event.stopPropagation(); state.movePane('right'); }}><ArrowRight size={12} /></Button>
                  <Button size="icon-xs" variant="ghost" aria-label={`Move ${pane.title} above neighbor`} onClick={event => { event.stopPropagation(); state.movePane('up'); }}><ArrowUp size={12} /></Button>
                  <Button size="icon-xs" variant="ghost" aria-label={`Move ${pane.title} below neighbor`} onClick={event => { event.stopPropagation(); state.movePane('down'); }}><ArrowDown size={12} /></Button>
                  <Button size="icon-xs" variant="ghost" aria-label={`Close ${pane.title}`} onClick={event => { event.stopPropagation(); state.closePane(pane.id); }}><X size={12} /></Button>
                </div>
              ) : chrome === 'quiet' ? <Button size="icon-xs" variant="ghost" aria-label={`Open commands for ${pane.title}`} onClick={event => { event.stopPropagation(); state.focusPane(pane.id); }}><Menu size={12} /></Button> : null}
            </header>
            <div className="min-h-0 flex-1 overflow-hidden"><PaneBody pane={pane} /></div>
            {chrome === 'arrange' && active ? (
              <div className="absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-popover p-1 shadow-xl">
                <Button size="icon-xs" variant="ghost" aria-label="Make Pane narrower" onClick={event => { event.stopPropagation(); state.resizePane(-0.15); }}><ChevronLeft size={12} /></Button>
                <span className="px-1 text-[9px]">Resize</span>
                <Button size="icon-xs" variant="ghost" aria-label="Make Pane wider" onClick={event => { event.stopPropagation(); state.resizePane(0.15); }}><ChevronRight size={12} /></Button>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
};

const FilesPanel = ({ state }: { state: PrototypeState }) => (
  <aside className="flex w-56 shrink-0 flex-col border-l border-border bg-muted/20" aria-label="Workspace Files">
    <header className="flex h-11 items-center gap-2 border-b border-border px-3"><Files size={14} /><span className="text-xs font-semibold uppercase tracking-wider">Files</span></header>
    <div className="p-2 text-xs">
      {['components/app-shell/WeaveAppShell.tsx', 'stores/workspace-surface-store.ts', 'CONTEXT.md'].map(path => <button key={path} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-muted" onClick={() => state.openFile(path)}><FileCode2 size={12} /><span className="truncate">{path}</span></button>)}
    </div>
    <div className="mt-auto border-t border-border p-3 text-[10px] text-muted-foreground">Files always route to this Tab’s preferred Editor Pane.</div>
  </aside>
);

const WorkspaceFrame = ({ children, state }: { children: ReactNode; state: PrototypeState }) => (
  <div className="flex h-full min-h-0 flex-1">
    <aside className="flex w-14 shrink-0 flex-col items-center border-r border-border bg-muted/25 py-2">
      <div className="mb-3 flex size-8 items-center justify-center rounded-lg bg-primary font-semibold text-primary-foreground">W</div>
      <Button size="icon-sm" variant="secondary" aria-label="Threads"><MessageSquare size={16} /></Button>
      <Button size="icon-sm" variant="ghost" aria-label="Files"><Files size={16} /></Button>
      <button className="relative mt-4 flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary" aria-label="Activate running Thread" onClick={state.activateThread}><Bot size={16} /></button>
    </aside>
    <div className="flex min-w-0 flex-1 flex-col">{children}</div>
  </div>
);

const CommandPalette = ({ commands, onClose }: { commands: CommandItem[]; onClose: () => void }) => {
  const [query, setQuery] = useState('');
  const visible = commands.filter(command => `${command.group} ${command.label} ${command.detail}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center bg-black/40 pt-24" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Workbench commands" className="w-[540px] overflow-hidden rounded-xl border border-border bg-popover shadow-2xl" onMouseDown={event => event.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-border px-4"><Search size={16} className="text-muted-foreground" /><input autoFocus className="h-12 flex-1 bg-transparent text-sm outline-none" placeholder="Search Pane and Workspace Tab commands…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') onClose(); }} /><kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">Esc</kbd></div>
        <div className="max-h-96 overflow-auto p-2">
          {visible.map(command => <button key={command.id} className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-muted" onClick={() => { command.run(); onClose(); }}><Command size={13} className="text-primary" /><div className="min-w-0 flex-1"><div className="text-xs font-medium">{command.label}</div><div className="truncate text-[10px] text-muted-foreground">{command.group} · {command.detail}</div></div>{command.shortcut ? <kbd className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px]">{command.shortcut}</kbd> : null}</button>)}
        </div>
      </div>
    </div>
  );
};

const LocalControlsVariant = ({ commands, onPalette, state }: { commands: CommandItem[]; onPalette: () => void; state: PrototypeState }) => (
  <WorkspaceFrame state={state}>
    <header className="flex h-12 items-center gap-2 border-b border-border px-3">
      <div className="min-w-0 flex-1"><div className="text-sm font-medium">Weave <span className="text-muted-foreground">/ main</span></div><div className="text-[10px] text-muted-foreground">Accepted direction · manipulation lives on the focused Pane</div></div>
      <Button size="sm" className="gap-1.5 text-xs" onClick={onPalette}><Command size={13} /> Commands <kbd className="ml-1 opacity-70">⌘K</kbd></Button>
    </header>
    <WorkspaceTabs state={state} />
    <div className="flex min-h-0 flex-1"><PaneCanvas chrome="local" state={state} /><FilesPanel state={state} /></div>
    <div className="flex h-9 items-center gap-2 border-t border-border px-3 text-[10px] text-muted-foreground"><MousePointer2 size={12} /> Focus a Pane to reveal split, directional move, maximize, and close · New Pane lives on the active Workspace Tab · commands and keybindings work everywhere.</div>
  </WorkspaceFrame>
);

const CommandDeckVariant = ({ commands, onPalette, state }: { commands: CommandItem[]; onPalette: () => void; state: PrototypeState }) => (
  <WorkspaceFrame state={state}>
    <header className="flex h-12 items-center gap-2 border-b border-border px-3"><div className="min-w-0 flex-1"><div className="text-sm font-medium">Weave <span className="text-muted-foreground">/ main</span></div><div className="text-[10px] text-muted-foreground">Command deck · stable names and shortcuts are the primary surface</div></div><Button size="sm" className="gap-1.5 text-xs" onClick={onPalette}><Search size={13} /> Search all commands <kbd className="ml-1 opacity-70">⌘K</kbd></Button></header>
    <WorkspaceTabs compact state={state} />
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-muted/15">
        <div className="flex items-center gap-2 border-b border-border px-3 py-3 text-xs font-semibold"><Keyboard size={14} /> Workbench command deck</div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {(['Pane', 'Workspace Tab', 'Workbench'] as const).map(group => <div key={group} className="mb-3"><div className="px-2 py-1 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">{group}</div>{commands.filter(command => command.group === group).slice(0, group === 'Pane' ? 5 : 3).map(command => <button key={command.id} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted" onClick={command.run}><span className="min-w-0 flex-1 truncate text-[11px]">{command.label}</span>{command.shortcut ? <kbd className="text-[9px] text-muted-foreground">{command.shortcut}</kbd> : null}</button>)}</div>)}
        </div>
      </aside>
      <PaneCanvas chrome="quiet" state={state} />
      <FilesPanel state={state} />
    </div>
    <div className="flex h-9 items-center gap-2 border-t border-border px-3 text-[10px] text-muted-foreground"><Command size={12} /> Pane headers stay quiet; the same named commands power palette, shortcuts, menus, and accessible controls.</div>
  </WorkspaceFrame>
);

const ArrangeModeVariant = ({ onPalette, state }: { onPalette: () => void; state: PrototypeState }) => {
  const [arranging, setArranging] = useState(false);
  return (
    <WorkspaceFrame state={state}>
      <header className="flex h-12 items-center gap-2 border-b border-border px-3"><div className="min-w-0 flex-1"><div className="text-sm font-medium">Weave <span className="text-muted-foreground">/ main</span></div><div className="text-[10px] text-muted-foreground">Arrange mode · layout mutation is an explicit, reversible activity</div></div><Button size="sm" variant={arranging ? 'default' : 'outline'} className="gap-1.5 text-xs" onClick={() => setArranging(value => !value)}>{arranging ? <Check size={13} /> : <Move size={13} />}{arranging ? 'Done arranging' : 'Arrange'}</Button><Button size="icon-sm" variant="ghost" aria-label="Open command palette" onClick={onPalette}><Command size={14} /></Button></header>
      <WorkspaceTabs state={state} />
      {arranging ? (
        <div className="flex items-center gap-2 border-b border-primary/30 bg-primary/5 px-3 py-2 text-xs">
          <span className="font-semibold text-primary">Arrange Workspace Tab</span>
          <Button size="sm" variant="outline" className="gap-1 text-[10px]" onClick={() => state.splitPane('right', 'editor')}><PanelTop className="rotate-90" size={11} /> Split right</Button>
          <Button size="sm" variant="outline" className="gap-1 text-[10px]" onClick={() => state.splitPane('down', 'terminal')}><PanelTop size={11} /> Split below</Button>
          <Button size="sm" variant="outline" className="gap-1 text-[10px]" onClick={() => state.replacePane('editor')}><Replace size={11} /> Replace with Editor</Button>
          <select aria-label="Move focused Pane to Workspace Tab" className="ml-auto h-8 rounded border border-border bg-background px-2 text-[10px]" value="" onChange={event => state.movePaneToTab(event.target.value)}><option value="" disabled>Move Pane to…</option>{state.tabs.filter(tab => tab.id !== state.activeTabId).map(tab => <option key={tab.id} value={tab.id}>{tab.name}</option>)}</select>
          <Button size="sm" variant="ghost" className="gap-1 text-[10px]" onClick={() => state.closePane()}><X size={11} /> Close Pane</Button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1"><PaneCanvas chrome={arranging ? 'arrange' : 'quiet'} state={state} /><FilesPanel state={state} /></div>
      <div className="flex h-9 items-center gap-2 border-t border-border px-3 text-[10px] text-muted-foreground">{arranging ? <><GripVertical size={12} /> Select a numbered Pane, then move, split, replace, resize, or close it. “Done arranging” returns to content.</> : <><MousePointer2 size={12} /> Content mode hides layout controls; use Arrange or the command palette when the arrangement must change.</>}</div>
    </WorkspaceFrame>
  );
};

const PrototypeSwitcher = ({ current, onChange }: { current: VariantKey; onChange: (next: VariantKey) => void }) => {
  const index = variants.findIndex(variant => variant.key === current);
  const cycle = useCallback((direction: -1 | 1) => onChange(variants[(index + direction + variants.length) % variants.length].key), [index, onChange]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key === 'ArrowLeft') cycle(-1);
      if (event.key === 'ArrowRight') cycle(1);
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [cycle]);
  const variant = variants[index];
  return <div className="fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/15 bg-[#151720] px-2 py-1.5 text-white shadow-2xl"><Button size="icon-sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" aria-label="Previous command-surface variant" onClick={() => cycle(-1)}><ChevronLeft size={15} /></Button><div className="min-w-56 px-2 text-center"><div className="text-xs font-semibold">{variant.key} — {variant.name}</div><div className="text-[9px] text-white/60">{variant.summary}</div></div><Button size="icon-sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" aria-label="Next command-surface variant" onClick={() => cycle(1)}><ChevronRight size={15} /></Button></div>;
};

const Prototype = () => {
  const state = usePrototypeState();
  const commands = useCommands(state);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const initialVariant = useMemo<VariantKey>(() => {
    const value = new URLSearchParams(window.location.search).get('variant');
    return value === 'B' || value === 'C' ? value : 'A';
  }, []);
  const [variant, setVariantState] = useState<VariantKey>(initialVariant);
  const setVariant = useCallback((next: VariantKey) => {
    const url = new URL(window.location.href);
    url.searchParams.set('variant', next);
    window.history.replaceState({}, '', url);
    setVariantState(next);
  }, []);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.matches('input, textarea, select, [contenteditable="true"]');
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (event.key === 'Escape') setPaletteOpen(false);
      if (editing) return;
      if ((event.metaKey || event.ctrlKey) && event.code === 'Backslash') {
        event.preventDefault();
        state.splitPane(event.shiftKey ? 'down' : 'right', event.shiftKey ? 'terminal' : 'editor');
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        const key = event.key.toLowerCase();
        if (key === 'w') {
          event.preventDefault();
          if (event.shiftKey) state.closeTab();
          else state.closePane();
          return;
        }
        if (key === 't' && !event.shiftKey) {
          event.preventDefault();
          state.createTab();
          return;
        }
        if (key === 'j' && event.shiftKey) {
          event.preventDefault();
          state.activateThread();
          return;
        }
      }
      if (event.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        const direction = event.key.replace('Arrow', '').toLowerCase() as PaneDirection;
        if (event.shiftKey) state.movePane(direction);
        else state.focusDirectionalPane(direction);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        state.toggleMaximize();
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [state]);
  return (
    <main className="relative flex h-screen min-h-[640px] flex-col overflow-hidden bg-background text-foreground">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-amber-400/20 bg-amber-400/10 px-3 text-[10px] text-amber-200"><span className="font-semibold">PROTOTYPE</span><Minus size={10} /><span className="truncate">Accepted: focused-Pane controls and global commands. Remaining question: should directional movement swap with the geometric neighbor while layout cells stay fixed?</span></div>
      <div className="min-h-0 flex-1">{variant === 'A' ? <LocalControlsVariant commands={commands} onPalette={() => setPaletteOpen(true)} state={state} /> : null}{variant === 'B' ? <CommandDeckVariant commands={commands} onPalette={() => setPaletteOpen(true)} state={state} /> : null}{variant === 'C' ? <ArrangeModeVariant onPalette={() => setPaletteOpen(true)} state={state} /> : null}</div>
      <div className="pointer-events-none absolute bottom-0 left-14 right-0 z-40 flex h-7 items-center gap-2 border-t border-border bg-background/95 px-3 text-[10px] text-muted-foreground backdrop-blur"><ChevronsRight size={11} className="text-primary" /><span className="truncate">{state.lastAction}</span></div>
      {paletteOpen ? <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} /> : null}
      <PrototypeSwitcher current={variant} onChange={setVariant} />
    </main>
  );
};

const meta = {
  title: 'Prototypes/Pane Commands',
  component: Prototype,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Prototype>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CompareCommandSurfaces: Story = {};
