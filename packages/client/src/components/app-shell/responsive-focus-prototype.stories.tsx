// PROTOTYPE — three responsive shell contracts, switchable with ?variant=A|B|C.
// Four in-story viewport scenarios exercise collapse order, overlay focus, and landmark reachability for PER-9.
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor } from 'storybook/test';
import {
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  FileCode2,
  Files,
  FolderOpen,
  LayoutGrid,
  Menu,
  MessageSquare,
  PanelLeft,
  PanelRight,
  Search,
  SquareTerminal,
  X,
} from 'lucide-react';

import { cn } from '../../lib/cn';
import { Button } from '../ui/button';

type VariantKey = 'A' | 'B' | 'C';
type RegionMode = 'expanded' | 'rail' | 'overlay';
type PaneKey = 'thread' | 'editor' | 'terminal';
type OverlayKey = 'threads' | 'files';
type ViewportKey = 'wide' | 'medium' | 'compact' | 'narrow';

type ResponsiveMode = {
  files: RegionMode;
  panes: 'all' | 'focused';
  threads: RegionMode;
};

type VariantDefinition = {
  key: VariantKey;
  name: string;
  summary: string;
  modeForWidth: (width: number) => ResponsiveMode;
};

const variants: VariantDefinition[] = [
  {
    key: 'A',
    name: 'Progressive landmarks',
    summary: 'Threads rail first, file rail second, overlays last',
    modeForWidth: width => width >= 1280
      ? { threads: 'expanded', files: 'expanded', panes: 'all' }
      : width >= 980
        ? { threads: 'rail', files: 'expanded', panes: 'all' }
        : width >= 700
          ? { threads: 'rail', files: 'rail', panes: 'all' }
          : { threads: 'overlay', files: 'overlay', panes: 'focused' },
  },
  {
    key: 'B',
    name: 'Paired contraction',
    summary: 'Both side regions contract together at each step',
    modeForWidth: width => width >= 1240
      ? { threads: 'expanded', files: 'expanded', panes: 'all' }
      : width >= 820
        ? { threads: 'rail', files: 'rail', panes: 'all' }
        : { threads: 'overlay', files: 'overlay', panes: 'focused' },
  },
  {
    key: 'C',
    name: 'Canvas first',
    summary: 'Side regions become overlays before the workbench compresses',
    modeForWidth: width => width >= 1400
      ? { threads: 'expanded', files: 'expanded', panes: 'all' }
      : width >= 900
        ? { threads: 'overlay', files: 'rail', panes: 'all' }
        : { threads: 'overlay', files: 'overlay', panes: 'focused' },
  },
];

const viewportScenarios: Array<{ key: ViewportKey; label: string; width: number }> = [
  { key: 'wide', label: 'Wide 1440', width: 1440 },
  { key: 'medium', label: 'Medium 1080', width: 1080 },
  { key: 'compact', label: 'Compact 760', width: 760 },
  { key: 'narrow', label: 'Narrow 520', width: 520 },
];

const threads = [
  { id: 'per-9', title: 'Define responsive and focus behavior', workspace: 'Weave / main', signal: 'Running' },
  { id: 'portal', title: 'Recover Portal connection', workspace: 'Weave / main', signal: 'Attention' },
  { id: 'odin', title: 'Review activity sync', workspace: 'Odin / staging', signal: 'Unread' },
];

const files = [
  'components/app-shell/WeaveAppShell.tsx',
  'components/app-shell/useShellLayout.ts',
  'stores/workspace-surface-store.ts',
];

const panes: Array<{ key: PaneKey; title: string; subtitle: string }> = [
  { key: 'thread', title: 'Define responsive and focus behavior', subtitle: 'Thread Pane · Running' },
  { key: 'editor', title: 'WeaveAppShell.tsx', subtitle: 'Editor Pane · Preferred Editor Pane' },
  { key: 'terminal', title: 'dev:desktop', subtitle: 'Terminal Pane · ready' },
];

const paneIcon = (key: PaneKey) => {
  if (key === 'thread') return <MessageSquare size={13} />;
  if (key === 'terminal') return <SquareTerminal size={13} />;
  return <FileCode2 size={13} />;
};

const FocusOverlay = ({ children, labelledBy, onClose }: { children: ReactNode; labelledBy: string; onClose: () => void }) => {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const first = dialogRef.current?.querySelector<HTMLElement>('[data-autofocus], button, [href], input');
    first?.focus();
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled)') ?? []);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="absolute inset-0 z-40 bg-black/55 p-3" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        aria-labelledby={labelledBy}
        aria-modal="true"
        className="flex h-full max-w-[320px] flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
        onKeyDown={handleKeyDown}
        onMouseDown={event => event.stopPropagation()}
        role="dialog"
      >
        {children}
      </div>
    </div>
  );
};

const ThreadContents = ({ activeThread, compact = false, onSelect }: { activeThread: string; compact?: boolean; onSelect: (id: string) => void }) => (
  <>
    {!compact ? (
      <header className="flex h-12 items-center gap-2 border-b border-border px-2">
        <button className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" type="button">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-[10px] font-bold text-primary-foreground">W</span>
          <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">Weave / main</span><span className="block truncate text-[9px] text-muted-foreground">Workspace · main</span></span>
          <ChevronDown size={12} />
        </button>
      </header>
    ) : null}
    <div className={cn('min-h-0 flex-1 overflow-auto', compact ? 'space-y-2 p-2' : 'space-y-0.5 p-1.5')}>
      {!compact ? <div className="px-2 py-2 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">Threads</div> : null}
      {threads.map(thread => compact ? (
        <button
          key={thread.id}
          aria-label={`${thread.signal} Thread: ${thread.title} in ${thread.workspace}`}
          className={cn('relative grid size-9 place-items-center rounded-md outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring', thread.id === activeThread && 'bg-primary/15 text-primary')}
          onClick={() => onSelect(thread.id)}
          title={thread.title}
          type="button"
        >
          <Bot size={15} />
          <Circle className={cn('absolute right-1 top-1 size-1.5 fill-current', thread.signal === 'Attention' ? 'text-amber-400' : thread.signal === 'Unread' ? 'text-sky-400' : 'text-emerald-400')} />
        </button>
      ) : (
        <button
          key={thread.id}
          className={cn('flex w-full items-center gap-2 rounded-md px-2 py-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring', thread.id === activeThread && 'bg-primary/10 text-primary')}
          onClick={() => onSelect(thread.id)}
          type="button"
        >
          <span className="relative grid size-7 shrink-0 place-items-center rounded-md bg-muted"><Bot size={13} /><Circle className="absolute -right-0.5 -top-0.5 size-1.5 fill-emerald-400 text-emerald-400" /></span>
          <span className="min-w-0 flex-1"><span className="block truncate text-[11px] font-medium">{thread.title}</span><span className="block truncate text-[9px] text-muted-foreground">{thread.workspace}</span></span>
          <span className="text-[8px] text-muted-foreground">{thread.signal}</span>
        </button>
      ))}
    </div>
    {!compact ? <Button className="m-2 justify-start" size="sm" variant="ghost"><MessageSquare size={13} /> New Thread</Button> : null}
  </>
);

const FilesContents = ({ compact = false, onOpenFile, selectedFile }: { compact?: boolean; onOpenFile: (file: string) => void; selectedFile: string }) => (
  <>
    {!compact ? <header className="flex h-12 items-center gap-2 border-b border-border px-3 text-[10px] font-semibold uppercase tracking-widest"><Files size={13} />Workspace files</header> : null}
    <div className={cn('min-h-0 flex-1 overflow-auto', compact ? 'space-y-2 p-2' : 'p-2')}>
      {!compact ? <div className="mb-1 flex items-center gap-1.5 px-1 py-1 text-[10px] font-medium"><ChevronDown size={11} /><FolderOpen size={12} className="text-primary" />packages/client/src</div> : null}
      {files.map(file => compact ? (
        <button key={file} aria-label={`Open ${file}`} className="grid size-9 place-items-center rounded-md outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onOpenFile(file)} title={file} type="button"><FileCode2 size={14} /></button>
      ) : (
        <button key={file} className={cn('flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[10px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring', selectedFile === file && 'bg-primary/10 text-primary')} onClick={() => onOpenFile(file)} type="button"><FileCode2 size={11} /><span className="truncate">{file}</span></button>
      ))}
    </div>
  </>
);

const Pane = ({ active, pane, onFocus }: { active: boolean; pane: (typeof panes)[number]; onFocus: () => void }) => (
  <section
    aria-label={`${pane.subtitle}: ${pane.title}`}
    className={cn('flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border bg-background shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring', active ? 'border-primary/70 ring-1 ring-primary/25' : 'border-border')}
    onClick={onFocus}
    onFocus={onFocus}
    tabIndex={0}
  >
    <header className={cn('flex h-9 shrink-0 items-center gap-2 border-b px-2', active ? 'border-primary/30 bg-primary/5' : 'border-border bg-muted/25')}>
      <span className={active ? 'text-primary' : 'text-muted-foreground'}>{paneIcon(pane.key)}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{pane.title}</span>
      <span className="truncate text-[8px] text-muted-foreground">{pane.subtitle.split(' · ')[0]}</span>
    </header>
    <div className="min-h-0 flex-1 overflow-hidden p-3 text-[10px] leading-5 text-muted-foreground">
      {pane.key === 'thread' ? <><p className="max-w-[90%] rounded-lg bg-muted px-2 py-1.5 text-foreground">Which responsive contract preserves all three landmarks?</p><p className="ml-auto mt-2 max-w-[86%] rounded-lg bg-primary/15 px-2 py-1.5">Exercise the viewport and keyboard scenarios.</p></> : null}
      {pane.key === 'editor' ? <pre className="font-mono"><code><span className="text-primary">type</span> WorkspaceTab = {'{'}{`\n`}  panes: Pane[];{`\n`}{'}'};</code></pre> : null}
      {pane.key === 'terminal' ? <pre className="font-mono"><code>$ bun run storybook{`\n`}<span className="text-emerald-400">ready</span> · localhost:6006</code></pre> : null}
    </div>
  </section>
);

const PrototypeSwitcher = ({ current, onChange }: { current: VariantKey; onChange: (key: VariantKey) => void }) => {
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
  return (
    <div className="fixed bottom-5 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/15 bg-[#151720] px-2 py-1.5 text-white shadow-2xl">
      <Button aria-label="Previous responsive variant" className="text-white hover:bg-white/10 hover:text-white" onClick={() => cycle(-1)} size="icon-sm" variant="ghost"><ChevronLeft size={15} /></Button>
      <div className="min-w-56 px-2 text-center"><div className="text-xs font-semibold">{variant.key} — {variant.name}</div><div className="text-[9px] text-white/60">{variant.summary}</div></div>
      <Button aria-label="Next responsive variant" className="text-white hover:bg-white/10 hover:text-white" onClick={() => cycle(1)} size="icon-sm" variant="ghost"><ChevronRight size={15} /></Button>
    </div>
  );
};

const ResponsiveShell = ({ variant, width }: { variant: VariantDefinition; width: number }) => {
  const mode = variant.modeForWidth(width);
  const rootRef = useRef<HTMLElement>(null);
  const threadsTriggerRef = useRef<HTMLButtonElement>(null);
  const filesTriggerRef = useRef<HTMLButtonElement>(null);
  const [activePane, setActivePane] = useState<PaneKey>('thread');
  const [activeTab, setActiveTab] = useState('Agent review');
  const [activeThread, setActiveThread] = useState('per-9');
  const [overlay, setOverlay] = useState<OverlayKey | null>(null);
  const [selectedFile, setSelectedFile] = useState(files[0]);
  const [status, setStatus] = useState('Ready. Press F6 to cycle through visible shell landmarks.');

  useEffect(() => {
    setOverlay(null);
    setStatus(`Responsive mode changed: Threads ${mode.threads}, Workspace Panes ${mode.panes}, files ${mode.files}.`);
  }, [mode.files, mode.panes, mode.threads]);

  const closeOverlay = useCallback((region: OverlayKey, message = `${region === 'threads' ? 'Global Threads' : 'Workspace files'} closed.`) => {
    setOverlay(null);
    setStatus(message);
    requestAnimationFrame(() => (region === 'threads' ? threadsTriggerRef.current : filesTriggerRef.current)?.focus());
  }, []);

  const openOverlay = (region: OverlayKey) => {
    setOverlay(region);
    setStatus(`${region === 'threads' ? 'Global Threads' : 'Workspace files'} opened as a modal overlay.`);
  };

  const selectThread = (id: string) => {
    const thread = threads.find(candidate => candidate.id === id)!;
    setActiveThread(id);
    setStatus(id === 'odin'
      ? `Cross-Workspace Thread selected: switched the complete shell to ${thread.workspace}, then focused ${thread.title}.`
      : `Focused Thread ${thread.title} in the current Workspace.`);
    if (overlay === 'threads') closeOverlay('threads', `Focused Thread ${thread.title}; focus returned to the global Threads trigger.`);
  };

  const openFile = (file: string) => {
    setSelectedFile(file);
    setActivePane('editor');
    setStatus(`Previewed ${file} in this Workspace Tab's Preferred Editor Pane.`);
    if (overlay === 'files') closeOverlay('files', `Previewed ${file}; focus returned to the Workspace files trigger.`);
  };

  const cycleLandmarks = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'F6') return;
    event.preventDefault();
    const landmarks = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-shell-landmark]:not([aria-hidden="true"])') ?? []);
    if (!landmarks.length) return;
    const current = landmarks.findIndex(landmark => landmark === document.activeElement || landmark.contains(document.activeElement));
    const next = landmarks[(current + 1) % landmarks.length];
    next.focus();
    setStatus(`Keyboard focus moved to ${next.dataset.shellLandmark}.`);
  };

  const renderedPanes = panes.map(pane => pane.key === 'editor' ? { ...pane, title: selectedFile.split('/').pop() ?? selectedFile } : pane);
  const visiblePanes = mode.panes === 'focused' ? renderedPanes.filter(pane => pane.key === activePane) : renderedPanes;

  return (
    <main ref={rootRef} className="relative flex h-full min-h-[600px] flex-col overflow-hidden bg-background text-foreground" onKeyDown={cycleLandmarks}>
      <a className="absolute left-2 top-1 z-[80] -translate-y-14 rounded bg-primary px-3 py-2 text-xs text-primary-foreground focus:translate-y-0" href="#workspace-tabs">Skip to Workspace Tabs</a>
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-amber-400/20 bg-amber-400/10 px-3 text-[9px] text-amber-200">
        <span className="font-semibold">PROTOTYPE</span><span aria-hidden="true">·</span><span className="truncate">{variant.name} at {width}px · Threads {mode.threads} · Panes {mode.panes} · Files {mode.files}</span>
      </div>
      <div className="flex min-h-0 flex-1">
        {mode.threads === 'expanded' ? <aside aria-label="Global Threads" className="flex w-72 shrink-0 flex-col border-r border-border bg-muted/20" data-shell-landmark="global Threads" tabIndex={-1}><ThreadContents activeThread={activeThread} onSelect={selectThread} /></aside> : null}
        {mode.threads === 'rail' ? <aside aria-label="Global Threads rail" className="flex w-14 shrink-0 flex-col items-center border-r border-border bg-muted/20" data-shell-landmark="global Threads rail" tabIndex={-1}><ThreadContents activeThread={activeThread} compact onSelect={selectThread} /></aside> : null}
        <section className="flex min-w-0 flex-1 flex-col" aria-label="Active Workspace">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2">
            {mode.threads === 'overlay' ? <Button ref={threadsTriggerRef} aria-controls="threads-overlay" aria-expanded={overlay === 'threads'} aria-label="Open global Threads" data-shell-landmark="global Threads trigger" onClick={() => openOverlay('threads')} size="icon-sm" variant="ghost"><PanelLeft size={14} /></Button> : null}
            <div className="min-w-0 flex-1"><div className="truncate text-xs font-medium">Weave <span className="text-muted-foreground">/ main</span></div><div className="truncate text-[9px] text-muted-foreground">Workspace · {activeTab} · {width}px</div></div>
            {mode.panes === 'focused' ? (
              <div aria-label="Choose visible Pane" className="flex gap-1" role="group">
                {panes.map(pane => <Button key={pane.key} aria-label={`Show ${pane.subtitle}`} onClick={() => { setActivePane(pane.key); setStatus(`Showing focused ${pane.subtitle}.`); }} size="icon-xs" variant={pane.key === activePane ? 'secondary' : 'ghost'}>{paneIcon(pane.key)}</Button>)}
              </div>
            ) : null}
            {mode.files === 'overlay' ? <Button ref={filesTriggerRef} aria-controls="files-overlay" aria-expanded={overlay === 'files'} aria-label="Open Workspace files" data-shell-landmark="Workspace files trigger" onClick={() => openOverlay('files')} size="icon-sm" variant="ghost"><PanelRight size={14} /></Button> : null}
          </header>
          <nav id="workspace-tabs" aria-label="Workspace Tabs" className="flex min-w-0 shrink-0 overflow-x-auto border-b border-border bg-muted/20 px-2 pt-1" data-shell-landmark="Workspace Tabs" tabIndex={-1}>
            {['Agent review', 'Desktop build', 'Architecture notes'].map(tab => (
              <button key={tab} aria-current={tab === activeTab ? 'page' : undefined} className={cn('flex h-8 shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 px-2 text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-ring', tab === activeTab ? 'border-border bg-background text-foreground' : 'border-transparent text-muted-foreground hover:bg-muted')} onClick={() => { setActiveTab(tab); setStatus(`Switched to Workspace Tab ${tab}; restored its Pane arrangement.`); }} type="button"><LayoutGrid size={11} />{tab}</button>
            ))}
          </nav>
          <div className={cn('grid min-h-0 flex-1 gap-2 bg-muted/10 p-2', visiblePanes.length === 1 ? 'grid-cols-1' : 'grid-cols-2 grid-rows-2')}>
            {visiblePanes.map((pane, index) => <div key={pane.key} className={cn('min-h-0 min-w-0', visiblePanes.length > 2 && index === 0 && 'row-span-2')}><Pane active={pane.key === activePane} pane={pane} onFocus={() => { setActivePane(pane.key); setStatus(`Focused ${pane.subtitle}.`); }} /></div>)}
          </div>
        </section>
        {mode.files === 'expanded' ? <aside aria-label="Workspace files" className="flex w-60 shrink-0 flex-col border-l border-border bg-muted/15" data-shell-landmark="Workspace files" tabIndex={-1}><FilesContents onOpenFile={openFile} selectedFile={selectedFile} /></aside> : null}
        {mode.files === 'rail' ? <aside aria-label="Workspace files rail" className="flex w-12 shrink-0 flex-col items-center border-l border-border bg-muted/15" data-shell-landmark="Workspace files rail" tabIndex={-1}><FilesContents compact onOpenFile={openFile} selectedFile={selectedFile} /></aside> : null}
      </div>
      <div aria-atomic="true" aria-live="polite" className="flex h-8 shrink-0 items-center gap-2 border-t border-border bg-background/95 px-3 text-[9px] text-muted-foreground"><Circle className="size-1.5 fill-emerald-400 text-emerald-400" /><span className="truncate">{status}</span><span className="ml-auto hidden sm:inline">F6 cycles landmarks · Tab reaches controls</span></div>
      {overlay === 'threads' ? (
        <FocusOverlay labelledBy="threads-overlay-title" onClose={() => closeOverlay('threads')}>
          <div className="flex h-11 items-center gap-2 border-b border-border px-3"><h2 className="flex-1 text-xs font-semibold" id="threads-overlay-title">Global Threads</h2><Button data-autofocus aria-label="Close global Threads" onClick={() => closeOverlay('threads')} size="icon-xs" variant="ghost"><X size={13} /></Button></div>
          <ThreadContents activeThread={activeThread} onSelect={selectThread} />
        </FocusOverlay>
      ) : null}
      {overlay === 'files' ? (
        <FocusOverlay labelledBy="files-overlay-title" onClose={() => closeOverlay('files')}>
          <div className="flex h-11 items-center gap-2 border-b border-border px-3"><h2 className="flex-1 text-xs font-semibold" id="files-overlay-title">Workspace files</h2><Button data-autofocus aria-label="Close Workspace files" onClick={() => closeOverlay('files')} size="icon-xs" variant="ghost"><X size={13} /></Button></div>
          <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[10px] text-muted-foreground"><Search size={12} />Filter files</div>
          <FilesContents onOpenFile={openFile} selectedFile={selectedFile} />
        </FocusOverlay>
      ) : null}
    </main>
  );
};

const Prototype = () => {
  const initialVariant = useMemo<VariantKey>(() => {
    const value = new URLSearchParams(window.location.search).get('variant');
    return value === 'B' || value === 'C' ? value : 'A';
  }, []);
  const initialViewport = useMemo<ViewportKey>(() => {
    const value = new URLSearchParams(window.location.search).get('viewport');
    return value === 'wide' || value === 'medium' || value === 'compact' || value === 'narrow' ? value : 'wide';
  }, []);
  const [variantKey, setVariantKey] = useState<VariantKey>(initialVariant);
  const [viewportKey, setViewportKey] = useState<ViewportKey>(initialViewport);
  const variant = variants.find(candidate => candidate.key === variantKey)!;
  const viewport = viewportScenarios.find(candidate => candidate.key === viewportKey)!;

  const updateVariant = (next: VariantKey) => {
    const url = new URL(window.location.href);
    url.searchParams.set('variant', next);
    window.history.replaceState({}, '', url);
    setVariantKey(next);
  };

  const updateViewport = (next: ViewportKey) => {
    const url = new URL(window.location.href);
    url.searchParams.set('viewport', next);
    window.history.replaceState({}, '', url);
    setViewportKey(next);
  };

  return (
    <div className="flex h-screen min-h-[680px] flex-col overflow-auto bg-[#0b0d12] p-2 text-foreground">
      <div className="mb-2 flex shrink-0 flex-wrap items-center justify-center gap-1" role="group" aria-label="Prototype viewport scenario">
        {viewportScenarios.map(scenario => <Button key={scenario.key} aria-pressed={scenario.key === viewportKey} onClick={() => updateViewport(scenario.key)} size="xs" variant={scenario.key === viewportKey ? 'secondary' : 'outline'}>{scenario.label}</Button>)}
      </div>
      <div className="mx-auto min-h-[600px] flex-1 shrink-0 overflow-hidden rounded-lg border border-white/10 shadow-2xl" style={{ width: viewport.width }}>
        <ResponsiveShell key={`${variant.key}-${viewport.key}`} variant={variant} width={viewport.width} />
      </div>
      <PrototypeSwitcher current={variantKey} onChange={updateVariant} />
    </div>
  );
};

const meta = {
  title: 'Prototypes/Responsive and Focus Behavior',
  component: Prototype,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Prototype>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CompareResponsiveContracts: Story = {};

export const OverlayFocusContract: Story = {
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Narrow 520' }));
    await canvas.findByText(/Progressive landmarks at 520px/);
    const threadsTrigger = await canvas.findByRole('button', { name: 'Open global Threads' });
    await userEvent.click(threadsTrigger);
    await expect(await canvas.findByRole('dialog', { name: 'Global Threads' })).toBeVisible();
    await expect(await canvas.findByRole('button', { name: 'Close global Threads' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(threadsTrigger).toHaveFocus());

    const filesTrigger = canvas.getByRole('button', { name: 'Open Workspace files' });
    await userEvent.click(filesTrigger);
    await expect(canvas.getByRole('dialog', { name: 'Workspace files' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: files[1] }));
    await waitFor(() => expect(filesTrigger).toHaveFocus());
    await expect(await canvas.findByRole('region', { name: /Editor Pane .* useShellLayout\.ts/ })).toBeVisible();
  },
};
