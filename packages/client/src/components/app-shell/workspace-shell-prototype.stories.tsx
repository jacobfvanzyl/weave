// PROTOTYPE — three Workspace Tab and Pane interaction models, switchable with ?variant=A|B|C.
// This Storybook-only artifact answers PER-6; it is not production shell code.
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  Circle,
  Code2,
  File,
  FileCode2,
  Files,
  Folder,
  FolderOpen,
  GripVertical,
  LayoutGrid,
  Maximize2,
  MessageSquare,
  Minus,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  SquareTerminal,
  X,
} from 'lucide-react';

import { cn } from '../../lib/cn';
import { Button } from '../ui/button';

type PaneKind = 'thread' | 'editor' | 'terminal';

type PaneModel = {
  id: string;
  kind: PaneKind;
  title: string;
  subtitle: string;
};

type WorkspaceTabModel = {
  id: string;
  name: string;
  panes: PaneModel[];
};

type VariantKey = 'A' | 'B' | 'C';

const variants: Array<{ key: VariantKey; name: string; summary: string }> = [
  { key: 'A', name: 'Workbench', summary: 'Tabs above a direct split canvas' },
  { key: 'B', name: 'Focus + dock', summary: 'Vertical Tabs with one primary Pane' },
  { key: 'C', name: 'Layout board', summary: 'Tab thumbnails and explicit Pane slots' },
];

const initialTabs: WorkspaceTabModel[] = [
  {
    id: 'review',
    name: 'Agent review',
    panes: [
      { id: 'thread-per-6', kind: 'thread', title: 'Prototype the Workspace shell', subtitle: 'Running · 42s' },
      { id: 'editor-shell', kind: 'editor', title: 'workspace-shell.tsx', subtitle: 'packages/client/src' },
      { id: 'terminal-dev', kind: 'terminal', title: 'dev:desktop', subtitle: 'bun run dev:desktop' },
    ],
  },
  {
    id: 'build',
    name: 'Desktop build',
    panes: [
      { id: 'editor-rpc', kind: 'editor', title: 'rpc-connection.ts', subtitle: 'desktop/src/main' },
      { id: 'terminal-test', kind: 'terminal', title: 'client tests', subtitle: 'bun test' },
    ],
  },
  {
    id: 'notes',
    name: 'Architecture notes',
    panes: [
      { id: 'editor-context', kind: 'editor', title: 'CONTEXT.md', subtitle: 'Weave' },
    ],
  },
];

const fileGroups = [
  { name: 'packages/client/src', files: ['components/app-shell/WeaveAppShell.tsx', 'stores/workspace-surface-store.ts', 'lib/editor-layout.ts'] },
  { name: 'desktop/src', files: ['main/rpc-connection.ts', 'renderer.tsx'] },
];

const paneIcon = (kind: PaneKind, size = 14) => {
  if (kind === 'thread') return <MessageSquare size={size} />;
  if (kind === 'terminal') return <SquareTerminal size={size} />;
  return <FileCode2 size={size} />;
};

const paneLabel: Record<PaneKind, string> = {
  thread: 'Thread Pane',
  editor: 'Editor Pane',
  terminal: 'Terminal Pane',
};

const makePane = (kind: PaneKind, serial: number): PaneModel => {
  if (kind === 'editor') return { id: `editor-new-${serial}`, kind, title: 'Untitled preview', subtitle: 'Choose a file from the tree' };
  if (kind === 'terminal') return { id: `terminal-new-${serial}`, kind, title: 'Terminal', subtitle: 'zsh · weave' };
  return { id: 'thread-per-6', kind, title: 'Prototype the Workspace shell', subtitle: 'Running · 42s' };
};

type PrototypeState = {
  activePaneId: string;
  activeTab: WorkspaceTabModel;
  activeTabId: string;
  addPane: (kind: PaneKind) => void;
  addTab: () => void;
  closePane: (paneId: string) => void;
  closeTab: (tabId: string) => void;
  fileTreeOpen: boolean;
  fileTreeWidth: number;
  focusPane: (paneId: string) => void;
  lastAction: string;
  movePane: (paneId: string, direction: -1 | 1) => void;
  openFile: (path: string) => void;
  openUniqueThread: () => void;
  paneRatio: number;
  selectedFile: string;
  selectTab: (tabId: string) => void;
  setFileTreeOpen: (open: boolean) => void;
  setFileTreeWidth: (width: number) => void;
  setPaneRatio: (ratio: number) => void;
  tabs: WorkspaceTabModel[];
};

const usePrototypeState = (): PrototypeState => {
  const [tabs, setTabs] = useState(initialTabs);
  const [activeTabId, setActiveTabId] = useState('review');
  const [activePaneId, setActivePaneId] = useState('thread-per-6');
  const [fileTreeOpen, setFileTreeOpen] = useState(true);
  const [fileTreeWidth, setFileTreeWidth] = useState(286);
  const [paneRatio, setPaneRatio] = useState(58);
  const [selectedFile, setSelectedFile] = useState('components/app-shell/WeaveAppShell.tsx');
  const [lastAction, setLastAction] = useState('Ready — every action is reflected here.');
  const [serial, setSerial] = useState(1);

  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? tabs[0];

  const selectTab = (tabId: string) => {
    const tab = tabs.find(candidate => candidate.id === tabId);
    if (!tab) return;
    setActiveTabId(tabId);
    setActivePaneId(tab.panes[0]?.id ?? '');
    setLastAction(`Switched to Workspace Tab “${tab.name}”. Its Pane arrangement was restored.`);
  };

  const focusPane = (paneId: string) => {
    setActivePaneId(paneId);
    const pane = activeTab.panes.find(candidate => candidate.id === paneId);
    if (pane) setLastAction(`Focused ${paneLabel[pane.kind]} “${pane.title}”.`);
  };

  const openUniqueThread = () => {
    const owner = tabs.find(tab => tab.panes.some(pane => pane.id === 'thread-per-6'));
    if (!owner) return;
    setActiveTabId(owner.id);
    setActivePaneId('thread-per-6');
    setLastAction('Activated the Thread’s existing Pane in “Agent review”; no duplicate Thread Pane was created.');
  };

  const addPane = (kind: PaneKind) => {
    if (kind === 'thread') {
      openUniqueThread();
      return;
    }
    const next = makePane(kind, serial);
    setSerial(value => value + 1);
    setTabs(current => current.map(tab => tab.id === activeTabId ? { ...tab, panes: [...tab.panes, next] } : tab));
    setActivePaneId(next.id);
    setLastAction(`Added a peer ${paneLabel[kind]} to “${activeTab.name}”.`);
  };

  const closePane = (paneId: string) => {
    const pane = activeTab.panes.find(candidate => candidate.id === paneId);
    setTabs(current => current.map(tab => tab.id === activeTabId ? { ...tab, panes: tab.panes.filter(candidate => candidate.id !== paneId) } : tab));
    if (activePaneId === paneId) setActivePaneId(activeTab.panes.find(candidate => candidate.id !== paneId)?.id ?? '');
    if (pane) setLastAction(`Closed ${paneLabel[pane.kind]} “${pane.title}”; the Workspace Tab remains open.`);
  };

  const addTab = () => {
    const id = `tab-${serial}`;
    const next: WorkspaceTabModel = { id, name: `Workspace Tab ${tabs.length + 1}`, panes: [] };
    setSerial(value => value + 1);
    setTabs(current => [...current, next]);
    setActiveTabId(id);
    setActivePaneId('');
    setLastAction(`Created “${next.name}”. It persists until explicitly closed.`);
  };

  const closeTab = (tabId: string) => {
    if (tabs.length === 1) return;
    const index = tabs.findIndex(tab => tab.id === tabId);
    const nextTabs = tabs.filter(tab => tab.id !== tabId);
    const nextActive = activeTabId === tabId ? nextTabs[Math.max(0, index - 1)] : activeTab;
    setTabs(nextTabs);
    setActiveTabId(nextActive.id);
    setActivePaneId(nextActive.panes[0]?.id ?? '');
    setLastAction(`Explicitly closed Workspace Tab “${tabs[index]?.name}”.`);
  };

  const openFile = (path: string) => {
    const editor = activeTab.panes.find(pane => pane.kind === 'editor');
    const title = path.split('/').pop() ?? path;
    setSelectedFile(path);
    if (editor) {
      setTabs(current => current.map(tab => tab.id === activeTabId
        ? { ...tab, panes: tab.panes.map(pane => pane.id === editor.id ? { ...pane, title, subtitle: path } : pane) }
        : tab));
      setActivePaneId(editor.id);
      setLastAction(`Previewed “${path}” in this Tab’s preferred Editor Pane.`);
      return;
    }
    const next = { ...makePane('editor', serial), title, subtitle: path };
    setSerial(value => value + 1);
    setTabs(current => current.map(tab => tab.id === activeTabId ? { ...tab, panes: [...tab.panes, next] } : tab));
    setActivePaneId(next.id);
    setLastAction(`Created an Editor Pane in “${activeTab.name}” and previewed “${path}”.`);
  };

  const movePane = (paneId: string, direction: -1 | 1) => {
    const index = activeTab.panes.findIndex(pane => pane.id === paneId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= activeTab.panes.length) return;
    const panes = [...activeTab.panes];
    [panes[index], panes[target]] = [panes[target], panes[index]];
    setTabs(current => current.map(tab => tab.id === activeTabId ? { ...tab, panes } : tab));
    setLastAction(`Moved “${panes[target].title}” ${direction < 0 ? 'earlier' : 'later'} in this Tab’s Pane arrangement.`);
  };

  return {
    activePaneId,
    activeTab,
    activeTabId,
    addPane,
    addTab,
    closePane,
    closeTab,
    fileTreeOpen,
    fileTreeWidth,
    focusPane,
    lastAction,
    movePane,
    openFile,
    openUniqueThread,
    paneRatio,
    selectedFile,
    selectTab,
    setFileTreeOpen,
    setFileTreeWidth,
    setPaneRatio,
    tabs,
  };
};

const PaneBody = ({ pane }: { pane: PaneModel }) => {
  if (pane.kind === 'thread') return (
    <div className="space-y-3 p-4 text-sm">
      <div className="max-w-[82%] rounded-xl rounded-tl-sm bg-muted px-3 py-2">Use Workspace Tabs for layouts that outlive a single task.</div>
      <div className="ml-auto max-w-[86%] rounded-xl rounded-tr-sm bg-primary px-3 py-2 text-primary-foreground">Prototype the interactions before we specify persistence.</div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Bot size={14} /> Working on clickable shell variants…</div>
    </div>
  );
  if (pane.kind === 'terminal') return (
    <div className="h-full bg-[#111318] p-4 font-mono text-xs leading-6 text-[#d7dae0]">
      <p><span className="text-[#8bd5ca]">weave</span> <span className="text-[#a6da95]">main*</span> bun run dev:desktop</p>
      <p className="text-[#8aadf4]">ready</p>
      <p className="text-[#939ab7]">Portal connected · 3 terminals restored</p>
      <p className="mt-2 animate-pulse">▋</p>
    </div>
  );
  return (
    <div className="grid h-full grid-cols-[auto_1fr] bg-background font-mono text-xs leading-6">
      <div className="select-none border-r border-border bg-muted/30 px-3 text-right text-muted-foreground">{[1, 2, 3, 4, 5, 6, 7, 8].map(line => <div key={line}>{line}</div>)}</div>
      <pre className="overflow-hidden p-3 text-foreground"><code><span className="text-chart-4">type</span> WorkspaceTab = {'{'}{`\n`}  id: string;{`\n`}  panes: Pane[];{`\n`}  preferredEditorPaneId?: string;{`\n`}{'}'};{`\n\n`}<span className="text-muted-foreground">// Pane arrangement belongs to the Tab.</span></code></pre>
    </div>
  );
};

const PaneCard = ({
  compact = false,
  pane,
  state,
  actions = true,
}: {
  compact?: boolean;
  pane: PaneModel;
  state: PrototypeState;
  actions?: boolean;
}) => {
  const active = pane.id === state.activePaneId;
  return (
    <section
      className={cn('flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border bg-background shadow-sm', active ? 'border-primary/70 ring-1 ring-primary/30' : 'border-border')}
      onClick={() => state.focusPane(pane.id)}
      data-pane-kind={pane.kind}
    >
      <header className={cn('flex h-9 shrink-0 items-center gap-2 border-b px-2', active ? 'border-primary/30 bg-primary/5' : 'border-border bg-muted/25')}>
        <span className={cn('text-muted-foreground', active && 'text-primary')}>{paneIcon(pane.kind)}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{pane.title}</div>
          {!compact ? <div className="truncate text-[10px] text-muted-foreground">{paneLabel[pane.kind]} · {pane.subtitle}</div> : null}
        </div>
        {actions ? (
          <div className="flex items-center">
            <Button size="icon-xs" variant="ghost" aria-label={`Move ${pane.title} earlier`} onClick={event => { event.stopPropagation(); state.movePane(pane.id, -1); }}><ChevronLeft size={12} /></Button>
            <Button size="icon-xs" variant="ghost" aria-label={`Move ${pane.title} later`} onClick={event => { event.stopPropagation(); state.movePane(pane.id, 1); }}><ChevronRight size={12} /></Button>
            <Button size="icon-xs" variant="ghost" aria-label={`Close ${pane.title}`} onClick={event => { event.stopPropagation(); state.closePane(pane.id); }}><X size={12} /></Button>
          </div>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-hidden"><PaneBody pane={pane} /></div>
    </section>
  );
};

const PaneAddButtons = ({ state, vertical = false }: { state: PrototypeState; vertical?: boolean }) => (
  <div className={cn('flex gap-1', vertical && 'flex-col')} aria-label="Add Pane">
    {(['thread', 'editor', 'terminal'] as PaneKind[]).map(kind => (
      <Button key={kind} size="sm" variant="outline" className={cn('gap-1.5 text-xs', vertical && 'justify-start')} onClick={() => state.addPane(kind)}>
        {paneIcon(kind, 13)} {vertical ? paneLabel[kind] : kind[0].toUpperCase() + kind.slice(1)}
      </Button>
    ))}
  </div>
);

const HorizontalTabs = ({ state }: { state: PrototypeState }) => (
  <div className="flex min-w-0 items-end gap-0.5 border-b border-border bg-muted/25 px-2 pt-2">
    {state.tabs.map(tab => (
      <button
        key={tab.id}
        className={cn('group flex h-9 max-w-52 items-center gap-2 rounded-t-md border border-b-0 px-3 text-xs', tab.id === state.activeTabId ? 'border-border bg-background text-foreground' : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground')}
        onClick={() => state.selectTab(tab.id)}
      >
        <LayoutGrid size={13} />
        <span className="truncate">{tab.name}</span>
        <span className="rounded bg-muted px-1 text-[10px]">{tab.panes.length}</span>
        <X className="opacity-0 group-hover:opacity-100" size={12} onClick={event => { event.stopPropagation(); state.closeTab(tab.id); }} />
      </button>
    ))}
    <Button size="icon-sm" variant="ghost" aria-label="New Workspace Tab" onClick={state.addTab}><Plus size={14} /></Button>
  </div>
);

const FileTree = ({ state }: { state: PrototypeState }) => (
  <aside
    className={cn('relative flex shrink-0 flex-col border-l border-border bg-muted/20 transition-[width] duration-200', state.fileTreeOpen ? 'min-w-56' : 'w-11')}
    style={state.fileTreeOpen ? { width: state.fileTreeWidth } : undefined}
    aria-label="Workspace file tree"
  >
    <header className={cn('flex h-11 shrink-0 items-center border-b border-border', state.fileTreeOpen ? 'gap-2 px-3' : 'justify-center')}>
      <Files size={15} />
      {state.fileTreeOpen ? <span className="flex-1 text-xs font-semibold uppercase tracking-wider">Files</span> : null}
      <Button size="icon-xs" variant="ghost" aria-label={state.fileTreeOpen ? 'Collapse file tree' : 'Expand file tree'} onClick={() => state.setFileTreeOpen(!state.fileTreeOpen)}>
        {state.fileTreeOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
      </Button>
    </header>
    {state.fileTreeOpen ? (
      <>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground"><Search size={13} /> Filter files</div>
        <div className="min-h-0 flex-1 overflow-auto p-2 text-xs">
          {fileGroups.map(group => (
            <div key={group.name} className="mb-2">
              <div className="flex items-center gap-1.5 px-1 py-1 font-medium"><ChevronDown size={12} /><FolderOpen size={13} className="text-primary" />{group.name}</div>
              {group.files.map(file => (
                <button key={file} className={cn('flex w-full items-center gap-1.5 rounded px-5 py-1.5 text-left hover:bg-muted', state.selectedFile === file && 'bg-primary/10 text-primary')} onClick={() => state.openFile(file)}>
                  <FileCode2 size={12} /><span className="truncate">{file}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <label className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
          File tree width · {state.fileTreeWidth}px
          <input className="mt-1 w-full accent-[var(--primary)]" type="range" min="224" max="420" value={state.fileTreeWidth} onChange={event => state.setFileTreeWidth(Number(event.target.value))} />
        </label>
      </>
    ) : (
      <div className="flex flex-1 flex-col items-center gap-3 pt-3 text-muted-foreground"><Folder size={15} /><File size={15} /><FileCode2 size={15} /></div>
    )}
  </aside>
);

const ActivityRail = ({ state }: { state: PrototypeState }) => (
  <aside className="flex w-14 shrink-0 flex-col items-center border-r border-border bg-muted/25 py-2">
    <div className="mb-3 flex size-8 items-center justify-center rounded-lg bg-primary font-semibold text-primary-foreground">W</div>
    <Button size="icon-sm" variant="secondary" aria-label="Threads"><MessageSquare size={16} /></Button>
    <Button size="icon-sm" variant="ghost" aria-label="Files"><Files size={16} /></Button>
    <Button size="icon-sm" variant="ghost" aria-label="Terminal"><SquareTerminal size={16} /></Button>
    <div className="mt-4 h-px w-7 bg-border" />
    <button className="relative mt-3 flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary" aria-label="Activate running Thread" onClick={state.openUniqueThread}>
      <Bot size={16} /><Circle className="absolute -right-0.5 -top-0.5 fill-emerald-400 text-emerald-400" size={7} />
    </button>
    <div className="mt-auto text-[9px] font-medium text-muted-foreground [writing-mode:vertical-rl]">WEAVE / MAIN</div>
  </aside>
);

const WorkspaceHeader = ({ state, children }: { state: PrototypeState; children?: ReactNode }) => (
  <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background px-3">
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-medium">Weave <span className="text-muted-foreground">/ main</span></div>
      <div className="truncate text-[10px] text-muted-foreground">Workspace · {state.activeTab.name}</div>
    </div>
    {children}
  </header>
);

const EmptyTab = ({ state }: { state: PrototypeState }) => (
  <div className="flex h-full flex-col items-center justify-center gap-4 border border-dashed border-border bg-muted/15 p-8 text-center">
    <LayoutGrid className="text-muted-foreground" size={32} />
    <div><p className="text-sm font-medium">This Workspace Tab has no Panes</p><p className="mt-1 text-xs text-muted-foreground">Add any peer Pane type, or activate the running Thread’s existing Pane.</p></div>
    <PaneAddButtons state={state} />
  </div>
);

const WorkbenchVariant = ({ state }: { state: PrototypeState }) => {
  const panes = state.activeTab.panes;
  return (
    <div className="flex min-h-0 flex-1">
      <ActivityRail state={state} />
      <div className="flex min-w-0 flex-1 flex-col">
        <WorkspaceHeader state={state}>
          <PaneAddButtons state={state} />
        </WorkspaceHeader>
        <HorizontalTabs state={state} />
        <div className="flex min-h-0 flex-1 bg-muted/10 p-2">
          {panes.length === 0 ? <EmptyTab state={state} /> : (
            <div className="grid min-h-0 flex-1 gap-2" style={{ gridTemplateColumns: panes.length === 1 ? '1fr' : `${state.paneRatio}fr ${100 - state.paneRatio}fr`, gridTemplateRows: panes.length > 2 ? 'minmax(0,1fr) minmax(0,.58fr)' : 'minmax(0,1fr)' }}>
              {panes.map((pane, index) => <div key={pane.id} className={cn('min-h-0 min-w-0', index === 0 && panes.length > 2 && 'row-span-2')}><PaneCard pane={pane} state={state} /></div>)}
            </div>
          )}
        </div>
        <label className="flex h-8 items-center gap-3 border-t border-border px-3 text-[10px] text-muted-foreground">
          Primary split · {state.paneRatio}%
          <input className="w-44 accent-[var(--primary)]" type="range" min="35" max="72" value={state.paneRatio} onChange={event => state.setPaneRatio(Number(event.target.value))} />
        </label>
      </div>
      <FileTree state={state} />
    </div>
  );
};

const FocusDockVariant = ({ state }: { state: PrototypeState }) => {
  const activePane = state.activeTab.panes.find(pane => pane.id === state.activePaneId) ?? state.activeTab.panes[0];
  const docked = state.activeTab.panes.filter(pane => pane.id !== activePane?.id);
  return (
    <div className="flex min-h-0 flex-1">
      <ActivityRail state={state} />
      <aside className="flex w-52 shrink-0 flex-col border-r border-border bg-muted/15">
        <div className="px-3 pb-2 pt-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Workspace Tabs</div>
        <div className="space-y-1 px-2">
          {state.tabs.map(tab => (
            <button key={tab.id} className={cn('group flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs', tab.id === state.activeTabId ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')} onClick={() => state.selectTab(tab.id)}>
              <LayoutGrid size={13} /><span className="min-w-0 flex-1 truncate">{tab.name}</span><span>{tab.panes.length}</span><X className="opacity-0 group-hover:opacity-100" size={12} onClick={event => { event.stopPropagation(); state.closeTab(tab.id); }} />
            </button>
          ))}
        </div>
        <Button variant="ghost" size="sm" className="mx-2 mt-2 justify-start gap-2 text-xs" onClick={state.addTab}><Plus size={13} /> New Workspace Tab</Button>
        <div className="mt-auto border-t border-border p-2"><PaneAddButtons state={state} vertical /></div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <WorkspaceHeader state={state}><span className="rounded-full border border-border px-2 py-1 text-[10px] text-muted-foreground">Focus + dock</span></WorkspaceHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-2 bg-muted/10 p-2">
          {activePane ? <div className="min-h-0 flex-[3]"><PaneCard pane={activePane} state={state} /></div> : <EmptyTab state={state} />}
          {docked.length ? (
            <div className="grid min-h-28 flex-1 gap-2" style={{ gridTemplateColumns: `repeat(${docked.length}, minmax(0, 1fr))` }}>
              {docked.map(pane => <PaneCard key={pane.id} compact pane={pane} state={state} actions={false} />)}
            </div>
          ) : null}
        </div>
        <div className="flex h-8 items-center gap-2 border-t border-border px-3 text-[10px] text-muted-foreground"><Maximize2 size={11} /> Selecting a docked Pane promotes it to focus.</div>
      </div>
      <FileTree state={state} />
    </div>
  );
};

const LayoutBoardVariant = ({ state }: { state: PrototypeState }) => (
  <div className="flex min-h-0 flex-1">
    <ActivityRail state={state} />
    <div className="flex min-w-0 flex-1 flex-col">
      <WorkspaceHeader state={state}><PaneAddButtons state={state} /></WorkspaceHeader>
      <div className="flex gap-2 overflow-x-auto border-b border-border bg-muted/15 p-2">
        {state.tabs.map(tab => (
          <button key={tab.id} className={cn('group w-40 shrink-0 rounded-md border p-2 text-left', tab.id === state.activeTabId ? 'border-primary/70 bg-primary/5' : 'border-border bg-background hover:border-muted-foreground/50')} onClick={() => state.selectTab(tab.id)}>
            <div className="mb-2 flex items-center gap-2 text-xs font-medium"><LayoutGrid size={13} /><span className="min-w-0 flex-1 truncate">{tab.name}</span><X className="opacity-0 group-hover:opacity-100" size={12} onClick={event => { event.stopPropagation(); state.closeTab(tab.id); }} /></div>
            <div className="grid h-9 grid-cols-3 gap-1">
              {tab.panes.length ? tab.panes.slice(0, 6).map(pane => <span key={pane.id} className="flex items-center justify-center rounded-sm bg-muted text-muted-foreground">{paneIcon(pane.kind, 10)}</span>) : <span className="col-span-3 flex items-center justify-center rounded-sm border border-dashed border-border text-[9px] text-muted-foreground">Empty</span>}
            </div>
          </button>
        ))}
        <button className="flex w-24 shrink-0 items-center justify-center gap-1 rounded-md border border-dashed border-border text-xs text-muted-foreground hover:border-primary hover:text-primary" onClick={state.addTab}><Plus size={13} /> Tab</button>
      </div>
      <div className="flex min-h-0 flex-1 gap-2 bg-muted/10 p-2">
        <aside className="flex w-36 shrink-0 flex-col rounded-md border border-border bg-background p-2">
          <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"><GripVertical size={12} /> Pane order</div>
          <div className="space-y-1">
            {state.activeTab.panes.map((pane, index) => (
              <button key={pane.id} className={cn('flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[10px]', pane.id === state.activePaneId ? 'bg-primary/10 text-primary' : 'hover:bg-muted')} onClick={() => state.focusPane(pane.id)}>
                <span className="text-muted-foreground">{index + 1}</span>{paneIcon(pane.kind, 11)}<span className="truncate">{pane.title}</span>
              </button>
            ))}
          </div>
          <div className="mt-auto space-y-1"><PaneAddButtons state={state} vertical /></div>
        </aside>
        {state.activeTab.panes.length ? (
          <div className="grid min-h-0 min-w-0 flex-1 grid-cols-2 gap-2">
            {state.activeTab.panes.map((pane, index) => <div key={pane.id} className={cn('min-h-0 min-w-0', index === 0 && 'row-span-2')}><PaneCard pane={pane} state={state} /></div>)}
          </div>
        ) : <div className="min-w-0 flex-1"><EmptyTab state={state} /></div>}
      </div>
    </div>
    <FileTree state={state} />
  </div>
);

const PrototypeSwitcher = ({ current, onChange }: { current: VariantKey; onChange: (variant: VariantKey) => void }) => {
  const currentIndex = variants.findIndex(variant => variant.key === current);
  const cycle = useCallback((direction: -1 | 1) => {
    const next = variants[(currentIndex + direction + variants.length) % variants.length];
    onChange(next.key);
  }, [currentIndex, onChange]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft') cycle(-1);
      if (event.key === 'ArrowRight') cycle(1);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [cycle]);

  const variant = variants[currentIndex];
  return (
    <div className="pointer-events-auto fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/15 bg-[#151720] px-2 py-1.5 text-white shadow-2xl">
      <Button size="icon-sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" aria-label="Previous prototype variant" onClick={() => cycle(-1)}><ChevronLeft size={15} /></Button>
      <div className="min-w-44 px-2 text-center"><div className="text-xs font-semibold">{variant.key} — {variant.name}</div><div className="text-[9px] text-white/60">{variant.summary}</div></div>
      <Button size="icon-sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" aria-label="Next prototype variant" onClick={() => cycle(1)}><ChevronRight size={15} /></Button>
    </div>
  );
};

const Prototype = () => {
  const state = usePrototypeState();
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

  return (
    <main className="relative flex h-screen min-h-[640px] flex-col overflow-hidden bg-background text-foreground">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-amber-400/20 bg-amber-400/10 px-3 text-[10px] text-amber-200">
        <span className="font-semibold">PROTOTYPE</span><Minus size={10} /><span className="truncate">Question: how should Workspace-local Tabs, arbitrary Panes, and the persistent right-side file tree behave together?</span>
      </div>
      <div className="min-h-0 flex-1">
        {variant === 'A' ? <WorkbenchVariant state={state} /> : null}
        {variant === 'B' ? <FocusDockVariant state={state} /> : null}
        {variant === 'C' ? <LayoutBoardVariant state={state} /> : null}
      </div>
      <div className="pointer-events-none absolute bottom-0 left-14 right-0 z-40 flex h-7 items-center gap-2 border-t border-border bg-background/95 px-3 text-[10px] text-muted-foreground backdrop-blur">
        <ChevronsRight size={11} className="text-primary" /><span className="truncate">{state.lastAction}</span>
      </div>
      <PrototypeSwitcher current={variant} onChange={setVariant} />
    </main>
  );
};

const meta = {
  title: 'Prototypes/Workspace Tabs and Panes',
  component: Prototype,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Prototype>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CompareInteractionModels: Story = {};
