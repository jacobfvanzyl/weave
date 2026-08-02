// PROTOTYPE — disposable Storybook evidence for the PER-13 Wayfinder decision.
import React, { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  BellDot,
  Bot,
  Boxes,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Circle,
  CircleDot,
  Command,
  FileCode2,
  Files,
  GitBranch,
  History,
  LayoutGrid,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  SquareTerminal,
  X,
  Zap,
} from 'lucide-react';

import { cn } from '../../lib/cn';
import { Button } from '../ui/button';

type VariantKey = 'A' | 'B' | 'C';
type Signal = 'running' | 'attention' | 'unread' | 'open' | 'quiet';

type Workspace = {
  id: string;
  name: string;
  project: string;
  branch: string;
  monogram: string;
  color: string;
};

type Thread = {
  id: string;
  title: string;
  workspaceId: string;
  signal: Signal;
  when: string;
};

const variants: Array<{ key: VariantKey; name: string; summary: string }> = [
  { key: 'A', name: 'Focus queue', summary: 'Workspace-ordered Threads + collapsed History' },
  { key: 'B', name: 'Signal rail', summary: 'Canvas-first rail with a temporary detail drawer' },
  { key: 'C', name: 'Workspace lens', summary: 'Workspace dock + command-style Thread lens' },
];

const workspaces: Workspace[] = [
  { id: 'weave-main', name: 'main', project: 'Weave', branch: 'main', monogram: 'W', color: 'bg-mauve/20 text-mauve' },
  { id: 'weave-portals', name: 'portal recovery', project: 'Weave', branch: 'fix/portal-heartbeat', monogram: 'P', color: 'bg-blue/20 text-blue' },
  { id: 'odin-time', name: 'time & attendance', project: 'Odin', branch: 'dev-188', monogram: 'O', color: 'bg-peach/20 text-peach' },
  { id: 'lodestone-staging', name: 'staging reference', project: 'Lodestone', branch: 'wayfinder/staging', monogram: 'L', color: 'bg-success/20 text-success' },
];

const initialThreads: Thread[] = [
  { id: 'per-13', title: 'Prototype global Threads and Workspace switching', workspaceId: 'weave-main', signal: 'attention', when: 'now' },
  { id: 'portal-recovery', title: 'Recover Portal after the Bazzite restart', workspaceId: 'weave-portals', signal: 'running', when: '42s' },
  { id: 'bun-validation', title: 'Review Bun migration validation', workspaceId: 'weave-main', signal: 'unread', when: '8m' },
  { id: 'time-handoff', title: 'Prepare Time & Attendance handoff', workspaceId: 'odin-time', signal: 'attention', when: '16m' },
  { id: 'outbox-trace', title: 'Trace staging outbox delivery', workspaceId: 'lodestone-staging', signal: 'open', when: '31m' },
  { id: 'blocks-overlay', title: 'Tune Terminal Block overlay', workspaceId: 'weave-main', signal: 'quiet', when: 'Yesterday' },
  { id: 'agent-roadmap', title: 'Map the agent-harness roadmap', workspaceId: 'weave-main', signal: 'quiet', when: 'Fri' },
  { id: 'storybook-harness', title: 'Establish the Storybook prototype harness', workspaceId: 'weave-main', signal: 'quiet', when: 'Thu' },
];

const signalPresentation: Record<Signal, { label: string; dot: string; icon: ReactNode }> = {
  running: { label: 'Running', dot: 'bg-success', icon: <Zap size={11} /> },
  attention: { label: 'Needs attention', dot: 'bg-warning', icon: <BellDot size={11} /> },
  unread: { label: 'Unread', dot: 'bg-blue', icon: <CircleDot size={11} /> },
  open: { label: 'Open', dot: 'bg-mauve', icon: <Circle size={11} /> },
  quiet: { label: 'History', dot: 'bg-muted-foreground/40', icon: <History size={11} /> },
};

const workspaceById = new Map(workspaces.map(workspace => [workspace.id, workspace]));

const WorkspaceMark = ({ workspace, size = 'md' }: { workspace: Workspace; size?: 'sm' | 'md' | 'lg' }) => (
  <span className={cn(
    'grid shrink-0 place-items-center rounded-md font-semibold',
    workspace.color,
    size === 'sm' && 'size-5 text-[9px]',
    size === 'md' && 'size-7 text-[11px]',
    size === 'lg' && 'size-9 text-xs',
  )}>{workspace.monogram}</span>
);

const SignalDot = ({ signal, className }: { signal: Signal; className?: string }) => (
  <span className={cn('size-1.5 shrink-0 rounded-full', signalPresentation[signal].dot, className)} />
);

const ThreadRow = ({
  active,
  compact = false,
  thread,
  onSelect,
}: {
  active: boolean;
  compact?: boolean;
  thread: Thread;
  onSelect: (thread: Thread) => void;
}) => {
  const workspace = workspaceById.get(thread.workspaceId)!;
  return (
    <button
      className={cn(
        'group flex w-full items-center gap-2 rounded-md text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        compact ? 'px-1.5 py-1.5' : 'px-2 py-2',
        active ? 'bg-selected-thread text-foreground' : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
      )}
      onClick={() => onSelect(thread)}
      type="button"
    >
      <WorkspaceMark size="sm" workspace={workspace} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{thread.title}</span>
        <span className="mt-0.5 flex items-center gap-1.5 truncate text-[9px] opacity-70">
          <span>{workspace.project} / {workspace.name}</span>
          <span>·</span>
          <span>{thread.when}</span>
        </span>
      </span>
      <SignalDot signal={thread.signal} />
    </button>
  );
};

const WorkspaceMenu = ({
  activeWorkspaceId,
  onSelect,
}: {
  activeWorkspaceId: string;
  onSelect: (workspaceId: string) => void;
}) => {
  const projects = Array.from(new Set(workspaces.map(workspace => workspace.project)));
  return (
    <div className="absolute left-2 right-2 top-12 z-30 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-2xl">
      <div className="mb-2 flex items-center gap-2 rounded-md border border-input bg-background px-2 py-1.5 text-[10px] text-muted-foreground">
        <Search size={12} /> Find a Workspace… <span className="ml-auto rounded border border-border px-1">⌘K</span>
      </div>
      {projects.map(project => (
        <div className="mb-2 last:mb-0" key={project}>
          <div className="px-2 py-1 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">{project}</div>
          {workspaces.filter(workspace => workspace.project === project).map(workspace => (
            <button
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
              key={workspace.id}
              onClick={() => onSelect(workspace.id)}
              type="button"
            >
              <WorkspaceMark size="sm" workspace={workspace} />
              <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
              <span className="truncate text-[9px] text-muted-foreground">{workspace.branch}</span>
              {workspace.id === activeWorkspaceId ? <Check className="text-primary" size={12} /> : null}
            </button>
          ))}
        </div>
      ))}
      <Button className="mt-1 w-full justify-start" size="xs" variant="ghost"><Plus size={12} /> Add Workspace</Button>
    </div>
  );
};

const sectionHeadingClassName = 'flex h-7 items-center gap-1.5 px-2 font-sans text-[9px] font-semibold uppercase tracking-widest text-muted-foreground';

const SectionHeading = ({ children, count, icon }: { children: ReactNode; count?: number; icon: ReactNode }) => (
  <div className={sectionHeadingClassName}>
    {icon}<span>{children}</span>{count === undefined ? null : <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[8px]">{count}</span>}
  </div>
);

const Workbench = ({ workspace, activeThread }: { workspace: Workspace; activeThread: Thread }) => (
  <section className="flex min-w-0 flex-1 flex-col bg-background">
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{workspace.project} <span className="text-muted-foreground">/ {workspace.name}</span></div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[9px] text-muted-foreground"><GitBranch size={10} />{workspace.branch}</div>
      </div>
      <Button size="xs" variant="ghost"><Command size={12} /> Commands</Button>
      <Button size="icon-sm" variant="ghost" aria-label="New Pane"><Plus size={14} /></Button>
    </header>
    <div className="flex h-9 items-end gap-1 border-b border-border bg-muted/20 px-2 pt-1">
      <button className="flex h-8 items-center gap-2 rounded-t-md border border-b-background border-border bg-background px-3 text-[10px]" type="button"><LayoutGrid size={12} />Agent review<X size={11} /></button>
      <button className="flex h-8 items-center gap-2 rounded-t-md px-3 text-[10px] text-muted-foreground hover:bg-muted" type="button"><LayoutGrid size={12} />Desktop build</button>
      <Button className="mb-1" size="icon-xs" variant="ghost" aria-label="New Workspace Tab"><Plus size={12} /></Button>
    </div>
    <div className="grid min-h-0 flex-1 grid-cols-[1.2fr_.8fr] grid-rows-2 gap-2 bg-muted/10 p-2">
      <div className="row-span-2 flex min-h-0 flex-col rounded-md border border-primary/40 bg-background shadow-sm">
        <div className="flex h-9 items-center gap-2 border-b border-border px-3 text-xs"><MessageSquare size={13} className="text-primary" /><span className="truncate font-medium">{activeThread.title}</span><span className="ml-auto text-[9px] text-muted-foreground">Thread Pane</span></div>
        <div className="min-h-0 flex-1 overflow-hidden p-4">
          <div className="max-w-md rounded-xl rounded-tl-sm bg-muted px-3 py-2 text-xs">The Workspace transition is complete. This Thread, its Tabs, Panes, branch, and files now belong to <strong>{workspace.project} / {workspace.name}</strong>.</div>
          <div className="ml-auto mt-3 max-w-sm rounded-xl rounded-tr-sm bg-primary/15 px-3 py-2 text-xs">Keep the global signals reachable without making the current Workspace feel secondary.</div>
        </div>
      </div>
      <div className="flex min-h-0 flex-col rounded-md border border-border bg-background">
        <div className="flex h-9 items-center gap-2 border-b border-border px-3 text-xs"><FileCode2 size={13} />workspace-shell.tsx<span className="ml-auto text-[9px] text-muted-foreground">Editor Pane</span></div>
        <div className="min-h-0 flex-1 overflow-hidden p-3 font-mono text-[9px] leading-5 text-muted-foreground"><span className="text-mauve">const</span> workspace = <span className="text-success">'{workspace.id}'</span>;<br /><span className="text-mauve">const</span> thread = <span className="text-success">'{activeThread.id}'</span>;</div>
      </div>
      <div className="flex min-h-0 flex-col rounded-md border border-border bg-background">
        <div className="flex h-9 items-center gap-2 border-b border-border px-3 text-xs"><SquareTerminal size={13} />dev:desktop<span className="ml-auto text-[9px] text-success">running</span></div>
        <div className="min-h-0 flex-1 overflow-hidden p-3 font-mono text-[9px] leading-5 text-muted-foreground">$ bun run dev:desktop<br /><span className="text-success">ready</span> · {workspace.branch}</div>
      </div>
    </div>
  </section>
);

type NavProps = {
  activeThreadId: string;
  activeWorkspaceId: string;
  onSelectThread: (thread: Thread) => void;
  onSelectWorkspace: (workspaceId: string) => void;
};

const FocusQueue = ({ activeThreadId, activeWorkspaceId, onSelectThread, onSelectWorkspace }: NavProps) => {
  const [collapsed, setCollapsed] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const activeWorkspace = workspaceById.get(activeWorkspaceId)!;
  const globalThreads = initialThreads.filter(thread => thread.signal !== 'quiet');
  const globalIds = new Set(globalThreads.map(thread => thread.id));
  const history = initialThreads.filter(thread => thread.workspaceId === activeWorkspaceId && !globalIds.has(thread.id));
  const workspaceRecency = new Map<string, number>();
  globalThreads.forEach((thread, index) => {
    if (!workspaceRecency.has(thread.workspaceId)) workspaceRecency.set(thread.workspaceId, index);
  });
  const orderedWorkspaceIds = [...workspaceRecency.keys()].sort((left, right) => {
    if (left === activeWorkspaceId) return -1;
    if (right === activeWorkspaceId) return 1;
    return (workspaceRecency.get(left) ?? Number.MAX_SAFE_INTEGER) - (workspaceRecency.get(right) ?? Number.MAX_SAFE_INTEGER);
  });
  const orderedThreads = orderedWorkspaceIds.flatMap(workspaceId => globalThreads.filter(thread => thread.workspaceId === workspaceId));

  if (collapsed) {
    return (
      <aside className="flex w-14 shrink-0 flex-col items-center border-r border-border bg-muted/25 py-2" aria-label="Collapsed global Threads sidebar">
        <button className="relative mb-3" onClick={() => setMenuOpen(value => !value)} type="button"><WorkspaceMark size="lg" workspace={activeWorkspace} /><ChevronDown className="absolute -bottom-1 -right-1 rounded-full bg-background" size={11} /></button>
        <Button size="icon-sm" variant="secondary" aria-label="Expand Threads" onClick={() => setCollapsed(false)}><PanelLeftOpen size={15} /></Button>
        <div className="mt-3 h-px w-7 bg-border" />
        {globalThreads.map(thread => {
          const workspace = workspaceById.get(thread.workspaceId)!;
          return <button className={cn('relative mt-2 rounded-md p-1', thread.id === activeThreadId && 'bg-selected-thread')} key={thread.id} onClick={() => onSelectThread(thread)} title={thread.title} type="button"><WorkspaceMark workspace={workspace} /><SignalDot className="absolute right-0 top-0 ring-2 ring-background" signal={thread.signal} /></button>;
        })}
        {menuOpen ? <div className="absolute left-14 top-2 z-30 w-72"><WorkspaceMenu activeWorkspaceId={activeWorkspaceId} onSelect={workspaceId => { onSelectWorkspace(workspaceId); setMenuOpen(false); }} /></div> : null}
        <span className="mt-auto text-[8px] uppercase tracking-widest text-muted-foreground [writing-mode:vertical-rl]">Focus queue</span>
      </aside>
    );
  }

  return (
    <aside className="relative flex w-72 shrink-0 flex-col border-r border-border bg-muted/20" aria-label="Global Threads sidebar">
      <div className="flex h-12 items-center gap-2 border-b border-border px-2">
        <button className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left hover:bg-muted" onClick={() => setMenuOpen(value => !value)} type="button">
          <WorkspaceMark workspace={activeWorkspace} />
          <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{activeWorkspace.project} / {activeWorkspace.name}</span><span className="block truncate text-[9px] text-muted-foreground">{activeWorkspace.branch}</span></span>
          <ChevronDown size={13} />
        </button>
        <Button size="icon-sm" variant="ghost" aria-label="Collapse to status rail" onClick={() => setCollapsed(true)}><PanelLeftClose size={14} /></Button>
      </div>
      {menuOpen ? <WorkspaceMenu activeWorkspaceId={activeWorkspaceId} onSelect={workspaceId => { onSelectWorkspace(workspaceId); setMenuOpen(false); }} /> : null}
      <SectionHeading count={globalThreads.length} icon={<Bot size={11} />}>Threads</SectionHeading>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-auto px-1.5">
        {orderedThreads.map(thread => <ThreadRow active={thread.id === activeThreadId} compact key={thread.id} onSelect={onSelectThread} thread={thread} />)}
      </div>
      <div className="mx-2 my-2 h-px bg-border" />
      <button
        aria-expanded={historyOpen}
        className={cn(sectionHeadingClassName, 'w-full hover:text-foreground')}
        onClick={() => setHistoryOpen(value => !value)}
        type="button"
      >
        {historyOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <History size={11} /><span className="font-sans text-[9px] font-semibold leading-[13.5px] tracking-widest">History</span><span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[8px]">{history.length}</span>
      </button>
      {historyOpen ? <div className="space-y-0.5 px-1.5">{history.map(thread => <ThreadRow active={thread.id === activeThreadId} compact key={thread.id} onSelect={onSelectThread} thread={thread} />)}</div> : null}
      <Button className="mx-2 mt-auto mb-2 justify-start" size="sm" variant="ghost"><Plus size={13} /> New Thread in {activeWorkspace.name}</Button>
    </aside>
  );
};

const SignalRail = ({ activeThreadId, activeWorkspaceId, onSelectThread, onSelectWorkspace }: NavProps) => {
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const activeWorkspace = workspaceById.get(activeWorkspaceId)!;
  const globalThreads = initialThreads.filter(thread => thread.signal !== 'quiet');
  const workspaceThreads = initialThreads.filter(thread => thread.workspaceId === activeWorkspaceId);
  return (
    <div className="relative z-20 flex shrink-0">
      <aside className="flex w-14 shrink-0 flex-col items-center border-r border-border bg-muted/25 py-2" aria-label="Global Thread signal rail">
        <button className="relative mb-3" onClick={() => setMenuOpen(value => !value)} type="button"><WorkspaceMark size="lg" workspace={activeWorkspace} /><ChevronDown className="absolute -bottom-1 -right-1 rounded-full bg-background" size={11} /></button>
        <Button size="icon-sm" variant={drawerOpen ? 'secondary' : 'ghost'} aria-label="Toggle Thread drawer" onClick={() => setDrawerOpen(value => !value)}><MessageSquare size={15} /></Button>
        <div className="mt-3 h-px w-7 bg-border" />
        {globalThreads.map(thread => {
          const workspace = workspaceById.get(thread.workspaceId)!;
          return <button className={cn('relative mt-2 rounded-md p-1', thread.id === activeThreadId && 'bg-selected-thread')} key={thread.id} onClick={() => onSelectThread(thread)} title={`${signalPresentation[thread.signal].label}: ${thread.title}`} type="button"><WorkspaceMark workspace={workspace} /><SignalDot className="absolute right-0 top-0 ring-2 ring-background" signal={thread.signal} /></button>;
        })}
        <Button className="mt-auto" size="icon-sm" variant="ghost" aria-label="Open Thread search"><Search size={14} /></Button>
      </aside>
      {drawerOpen ? (
        <aside className="absolute bottom-3 left-16 top-3 flex w-72 flex-col rounded-lg border border-border bg-popover/95 shadow-2xl backdrop-blur" aria-label="Thread detail drawer">
          <div className="flex h-10 items-center gap-2 border-b border-border px-3 text-xs font-semibold"><Zap size={12} className="text-primary" />Signals<span className="ml-auto text-[9px] font-normal text-muted-foreground">global</span><Button size="icon-xs" variant="ghost" aria-label="Close drawer" onClick={() => setDrawerOpen(false)}><X size={12} /></Button></div>
          <div className="min-h-0 flex-1 overflow-auto p-1.5">
            {globalThreads.map(thread => <ThreadRow active={thread.id === activeThreadId} compact key={thread.id} onSelect={onSelectThread} thread={thread} />)}
            <div className="mx-1 my-2 h-px bg-border" />
            <SectionHeading count={workspaceThreads.length} icon={<History size={11} />}>{activeWorkspace.name}</SectionHeading>
            {workspaceThreads.map(thread => <ThreadRow active={thread.id === activeThreadId} compact key={`history-${thread.id}`} onSelect={onSelectThread} thread={thread} />)}
          </div>
        </aside>
      ) : null}
      {menuOpen ? <div className="absolute left-14 top-0 z-40 w-72"><WorkspaceMenu activeWorkspaceId={activeWorkspaceId} onSelect={workspaceId => { onSelectWorkspace(workspaceId); setMenuOpen(false); }} /></div> : null}
    </div>
  );
};

const WorkspaceLens = ({ activeThreadId, activeWorkspaceId, onSelectThread, onSelectWorkspace }: NavProps) => {
  const [lensOpen, setLensOpen] = useState(true);
  const activeWorkspace = workspaceById.get(activeWorkspaceId)!;
  const visibleThreads = useMemo(() => {
    const global = initialThreads.filter(thread => thread.signal !== 'quiet');
    const history = initialThreads.filter(thread => thread.workspaceId === activeWorkspaceId && thread.signal === 'quiet');
    return [...global, ...history];
  }, [activeWorkspaceId]);
  return (
    <div className="relative z-20 flex shrink-0">
      <aside className="flex w-[72px] shrink-0 flex-col items-center border-r border-border bg-muted/25 py-2" aria-label="Workspace dock">
        <div className="mb-3 grid size-9 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">W</div>
        <span className="mb-1 text-[8px] font-semibold uppercase tracking-widest text-muted-foreground">Spaces</span>
        {workspaces.map(workspace => {
          const signalCount = initialThreads.filter(thread => thread.workspaceId === workspace.id && thread.signal !== 'quiet').length;
          return (
            <button className={cn('relative mb-1 rounded-lg p-1.5', workspace.id === activeWorkspaceId ? 'bg-selected-thread ring-1 ring-primary/40' : 'hover:bg-muted')} key={workspace.id} onClick={() => { onSelectWorkspace(workspace.id); setLensOpen(true); }} title={`${workspace.project} / ${workspace.name}`} type="button">
              <WorkspaceMark size="lg" workspace={workspace} />
              {signalCount ? <span className="absolute -right-0.5 -top-0.5 grid size-4 place-items-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground ring-2 ring-background">{signalCount}</span> : null}
            </button>
          );
        })}
        <Button className="mt-1" size="icon-sm" variant="ghost" aria-label="Add Workspace"><Plus size={14} /></Button>
        <Button className="mt-auto" size="icon-sm" variant={lensOpen ? 'secondary' : 'ghost'} aria-label="Toggle Thread lens" onClick={() => setLensOpen(value => !value)}><Command size={14} /></Button>
      </aside>
      {lensOpen ? (
        <aside className="absolute left-20 top-4 w-[340px] overflow-hidden rounded-xl border border-border bg-popover/95 shadow-2xl backdrop-blur" aria-label="Global Thread lens">
          <div className="flex h-11 items-center gap-2 border-b border-border px-3 text-xs text-muted-foreground"><Search size={14} /><span className="flex-1">Jump to a Thread or Workspace…</span><span className="rounded border border-border px-1.5 py-0.5 text-[9px]">⌘K</span></div>
          <div className="p-1.5">
            <div className="mb-1 flex items-center gap-2 rounded-md bg-primary/10 px-2 py-1.5 text-[10px] text-primary"><WorkspaceMark size="sm" workspace={activeWorkspace} /><span className="font-medium">{activeWorkspace.project} / {activeWorkspace.name}</span><span className="ml-auto">Current Workspace</span></div>
            <SectionHeading count={visibleThreads.length} icon={<Boxes size={11} />}>Global signals + local history</SectionHeading>
            {visibleThreads.map(thread => <ThreadRow active={thread.id === activeThreadId} compact key={thread.id} onSelect={onSelectThread} thread={thread} />)}
          </div>
          <div className="flex h-8 items-center gap-3 border-t border-border px-3 text-[9px] text-muted-foreground"><span>↵ Open</span><span>⌘↵ Open in new Workspace Tab</span><span className="ml-auto">Esc Close</span></div>
        </aside>
      ) : null}
    </div>
  );
};

const PrototypeSwitcher = ({ current, onChange }: { current: VariantKey; onChange: (variant: VariantKey) => void }) => {
  const currentIndex = variants.findIndex(variant => variant.key === current);
  const cycle = useCallback((direction: -1 | 1) => {
    onChange(variants[(currentIndex + direction + variants.length) % variants.length].key);
  }, [currentIndex, onChange]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.matches('input, textarea, [contenteditable="true"]')) return;
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
      <div className="min-w-56 px-2 text-center"><div className="text-xs font-semibold">{variant.key} — {variant.name}</div><div className="text-[9px] text-white/60">{variant.summary}</div></div>
      <Button size="icon-sm" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" aria-label="Next prototype variant" onClick={() => cycle(1)}><ChevronRight size={15} /></Button>
    </div>
  );
};

const Prototype = () => {
  const initialVariant = useMemo<VariantKey>(() => {
    const value = new URLSearchParams(window.location.search).get('variant');
    return value === 'B' || value === 'C' ? value : 'A';
  }, []);
  const [variant, setVariantState] = useState<VariantKey>(initialVariant);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState('weave-main');
  const [activeThreadId, setActiveThreadId] = useState('per-13');
  const [lastAction, setLastAction] = useState('Ready — select a Thread or Workspace; the complete transition is reported here.');

  const activeWorkspace = workspaceById.get(activeWorkspaceId)!;
  const activeThread = initialThreads.find(thread => thread.id === activeThreadId) ?? initialThreads[0];

  const setVariant = useCallback((next: VariantKey) => {
    const url = new URL(window.location.href);
    url.searchParams.set('variant', next);
    window.history.replaceState({}, '', url);
    setVariantState(next);
  }, []);

  const selectWorkspace = (workspaceId: string) => {
    const workspace = workspaceById.get(workspaceId)!;
    setActiveWorkspaceId(workspaceId);
    const mostRecent = initialThreads.find(thread => thread.workspaceId === workspaceId);
    if (mostRecent) setActiveThreadId(mostRecent.id);
    setLastAction(`Switched the complete shell to Workspace “${workspace.project} / ${workspace.name}”; restored its latest Workspace Tab and history.`);
  };

  const selectThread = (thread: Thread) => {
    const nextWorkspace = workspaceById.get(thread.workspaceId)!;
    const crossedWorkspace = thread.workspaceId !== activeWorkspaceId;
    setActiveWorkspaceId(thread.workspaceId);
    setActiveThreadId(thread.id);
    setLastAction(crossedWorkspace
      ? `Cross-Workspace Thread selection: switched to “${nextWorkspace.project} / ${nextWorkspace.name}”, restored its Workspace Tabs and files, then focused “${thread.title}”.`
      : `Focused “${thread.title}” inside the current Workspace; the Workspace shell did not transition.`);
  };

  const navProps: NavProps = { activeThreadId, activeWorkspaceId, onSelectThread: selectThread, onSelectWorkspace: selectWorkspace };

  return (
    <main className="relative flex h-screen min-h-[640px] flex-col overflow-hidden bg-background text-foreground">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-amber-400/20 bg-amber-400/10 px-3 text-[10px] text-amber-200">
        <span className="font-semibold">PROTOTYPE</span><ChevronsRight size={10} /><span className="truncate">Question: how should the far-left global Threads sidebar and Workspace switcher behave?</span>
      </div>
      <div className="flex min-h-0 flex-1">
        {variant === 'A' ? <FocusQueue {...navProps} /> : null}
        {variant === 'B' ? <SignalRail {...navProps} /> : null}
        {variant === 'C' ? <WorkspaceLens {...navProps} /> : null}
        <Workbench activeThread={activeThread} workspace={activeWorkspace} />
        <aside className="hidden w-52 shrink-0 flex-col border-l border-border bg-muted/15 lg:flex">
          <div className="flex h-12 items-center gap-2 border-b border-border px-3 text-[10px] font-semibold uppercase tracking-widest"><Files size={13} />Files</div>
          <div className="p-2 text-[10px] text-muted-foreground"><div className="flex items-center gap-1.5 py-1"><ChevronDown size={11} />src</div><div className="flex items-center gap-1.5 py-1 pl-4"><FileCode2 size={11} />workspace-shell.tsx</div><div className="flex items-center gap-1.5 py-1 pl-4"><FileCode2 size={11} />thread-navigation.tsx</div></div>
        </aside>
      </div>
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-40 flex h-7 items-center gap-2 border-t border-border bg-background/95 px-3 text-[10px] text-muted-foreground backdrop-blur">
        <ChevronsRight size={11} className="text-primary" /><span className="truncate">{lastAction}</span>
      </div>
      <PrototypeSwitcher current={variant} onChange={setVariant} />
    </main>
  );
};

const meta = {
  title: 'Wayfinder/Global Threads and Workspace Switching',
  component: Prototype,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Prototype>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CompareInteractionModels: Story = {};
