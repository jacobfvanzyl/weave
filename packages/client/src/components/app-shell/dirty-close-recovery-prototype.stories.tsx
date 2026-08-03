// PROTOTYPE — three Close Transaction interaction models, switchable with ?variant=A|B|C.
// This Storybook-only artifact answers PER-16; it does not implement persistence or lifecycle orchestration.
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import {
  AlertTriangle,
  Archive,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CloudOff,
  FileCode2,
  Files,
  FolderOpen,
  HardDriveDownload,
  History,
  LoaderCircle,
  MessageSquare,
  PanelRightClose,
  RotateCcw,
  Save,
  ShieldAlert,
  SquareTerminal,
  Trash2,
  Unplug,
  X,
} from 'lucide-react';

import { cn } from '../../lib/cn';
import { Button } from '../ui/button';

type VariantKey = 'A' | 'B' | 'C';
type CloseScope = 'pane' | 'tab' | 'workspace';
type TransactionPhase = 'review' | 'partial' | 'resolved';
type BufferChoice = 'save' | 'draft' | 'export' | 'discard';

type DirtyBuffer = {
  id: string;
  path: string;
  detail: string;
  owner: string;
  remote?: boolean;
  disconnectedDraft?: boolean;
};

const variants: Array<{ key: VariantKey; name: string; summary: string }> = [
  { key: 'A', name: 'Impact ledger', summary: 'Scan every consequence, then resolve once' },
  { key: 'B', name: 'Guided resolution', summary: 'Resolve one lifecycle category at a time' },
  { key: 'C', name: 'Recovery drawer', summary: 'Keep the affected Workspace visible while deciding' },
];

const scopeCopy: Record<CloseScope, { label: string; target: string; consequence: string }> = {
  pane: {
    label: 'Close Pane',
    target: 'Editor Pane “shell-state.ts”',
    consequence: 'The Pane identity and its Editor Working Set will end. Files are never deleted.',
  },
  tab: {
    label: 'Close Workspace Tab',
    target: 'Workspace Tab “Recovery design”',
    consequence: 'This is the final Workspace Tab. A fresh empty “New Tab” will be created after closing succeeds.',
  },
  workspace: {
    label: 'Remove Workspace',
    target: 'Workspace “Weave / main”',
    consequence: 'Every Workspace Tab, Pane, and Client Presentation State will be removed after all lifecycle work succeeds.',
  },
};

const dirtyBuffers: DirtyBuffer[] = [
  {
    id: 'shell-state',
    path: 'packages/client/src/stores/shell-state.ts',
    detail: '18 unsaved lines · base revision 74',
    owner: 'This Mac',
  },
  {
    id: 'close-transaction',
    path: 'packages/protocol/src/close-transaction.ts',
    detail: 'Remote Dirty Claim · checkpointed 2m ago',
    owner: 'Desktop on bazzite',
    remote: true,
  },
  {
    id: 'recovery-notes',
    path: 'docs/close-recovery-notes.md',
    detail: 'Disconnected Recovery Draft · file target unavailable',
    owner: 'Offline browser',
    disconnectedDraft: true,
  },
];

const scopeBuffers = (scope: CloseScope) => scope === 'pane' ? dirtyBuffers.slice(0, 2) : dirtyBuffers;

const initialChoices = (scope: CloseScope): Record<string, BufferChoice> => Object.fromEntries(
  scopeBuffers(scope).map(buffer => [buffer.id, buffer.disconnectedDraft ? (scope === 'workspace' ? 'export' : 'draft') : 'save']),
);

const ChoicePill = ({
  active,
  children,
  disabled,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) => (
  <button
    aria-pressed={active}
    className={cn(
      'rounded-md border px-2.5 py-1.5 text-[10px] font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-ring',
      active ? 'border-primary/60 bg-primary/15 text-primary' : 'border-border bg-background text-muted-foreground hover:bg-muted',
      disabled && 'cursor-not-allowed opacity-45',
    )}
    disabled={disabled}
    onClick={onClick}
    type="button"
  >
    {children}
  </button>
);

const StatusBadge = ({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'warning' | 'danger' | 'success' }) => (
  <span className={cn(
    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-semibold',
    tone === 'warning' && 'border-amber-500/35 bg-amber-500/10 text-amber-300',
    tone === 'danger' && 'border-destructive/35 bg-destructive/10 text-destructive',
    tone === 'success' && 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300',
    tone === 'neutral' && 'border-border bg-muted text-muted-foreground',
  )}>{children}</span>
);

const BufferChoiceControl = ({
  buffer,
  choice,
  onChange,
  scope,
}: {
  buffer: DirtyBuffer;
  choice: BufferChoice;
  onChange: (choice: BufferChoice) => void;
  scope: CloseScope;
}) => {
  const choices: Array<{ key: BufferChoice; label: string }> = buffer.disconnectedDraft
    ? scope === 'workspace'
      ? [{ key: 'export', label: 'Export outside Workspace' }, { key: 'discard', label: 'Discard draft' }]
      : [{ key: 'draft', label: 'Keep Recovery Draft' }, { key: 'discard', label: 'Discard draft' }]
    : scope === 'workspace'
      ? [{ key: 'save', label: 'Save' }, { key: 'export', label: 'Export outside Workspace' }, { key: 'discard', label: 'Discard' }]
      : [{ key: 'save', label: 'Save' }, { key: 'draft', label: 'Keep Recovery Draft' }, { key: 'discard', label: 'Discard' }];

  return (
    <div aria-label={`Resolution for ${buffer.path}`} className="mt-2 flex flex-wrap gap-1.5" role="group">
      {choices.map(item => (
        <ChoicePill key={item.key} active={choice === item.key} onClick={() => onChange(item.key)}>{item.label}</ChoicePill>
      ))}
    </div>
  );
};

const ResourceIcon = ({ kind }: { kind: 'thread' | 'editor' | 'terminal' | 'draft' }) => {
  if (kind === 'thread') return <MessageSquare size={15} />;
  if (kind === 'terminal') return <SquareTerminal size={15} />;
  if (kind === 'draft') return <HardDriveDownload size={15} />;
  return <FileCode2 size={15} />;
};

const ResourceRow = ({
  children,
  detail,
  icon,
  status,
  title,
}: {
  children?: ReactNode;
  detail: string;
  icon: ReactNode;
  status?: ReactNode;
  title: string;
}) => (
  <div className="rounded-lg border border-border bg-background/70 p-3">
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5"><span className="break-all text-[11px] font-medium text-foreground">{title}</span>{status}</span>
        <span className="mt-0.5 block text-[9px] leading-4 text-muted-foreground">{detail}</span>
      </span>
    </div>
    {children}
  </div>
);

const EditorResources = ({
  choices,
  onChoice,
  phase,
  scope,
}: {
  choices: Record<string, BufferChoice>;
  onChoice: (id: string, choice: BufferChoice) => void;
  phase: TransactionPhase;
  scope: CloseScope;
}) => (
  <div className="space-y-2">
    {scopeBuffers(scope).map(buffer => {
      const failed = phase === 'partial' && buffer.id === 'shell-state' && choices[buffer.id] === 'save';
      return (
        <ResourceRow
          key={buffer.id}
          detail={`${buffer.detail} · ${buffer.owner}`}
          icon={<ResourceIcon kind={buffer.disconnectedDraft ? 'draft' : 'editor'} />}
          status={failed
            ? <StatusBadge tone="danger"><CircleAlert size={10} /> Save failed</StatusBadge>
            : buffer.remote
              ? <StatusBadge tone="warning"><CloudOff size={10} /> Remote owner</StatusBadge>
              : buffer.disconnectedDraft
                ? <StatusBadge tone="warning"><Unplug size={10} /> Disconnected</StatusBadge>
                : <StatusBadge tone="warning">Unsaved</StatusBadge>}
          title={buffer.path}
        >
          <BufferChoiceControl buffer={buffer} choice={choices[buffer.id]} onChange={choice => onChoice(buffer.id, choice)} scope={scope} />
          {failed ? <p className="mt-2 text-[9px] leading-4 text-destructive">Disk is read-only. The buffer and Pane remain open; retry after changing the resolution or restoring write access.</p> : null}
        </ResourceRow>
      );
    })}
  </div>
);

const RequiredResources = ({ phase, scope, only }: { phase: TransactionPhase; scope: CloseScope; only?: 'thread' | 'terminal' }) => scope === 'pane' ? null : (
  <div className="space-y-2">
    {only !== 'terminal' ? <ResourceRow
      detail="Agent execution has been running for 1m 42s. Permanent deletion is not part of this transaction."
      icon={<ResourceIcon kind="thread" />}
      status={phase === 'partial' ? <StatusBadge tone="success"><Check size={10} /> Stopped and archived</StatusBadge> : <StatusBadge tone="warning">Running</StatusBadge>}
      title="Thread “Prototype close recovery”"
    >
      <p className="mt-2 text-[9px] text-muted-foreground"><strong className="text-foreground">Required:</strong> Stop & archive before shared structure is removed.</p>
    </ResourceRow> : null}
    {only !== 'thread' ? <ResourceRow
      detail="Non-idle shell · job: bun run storybook · Portal bazzite is unreachable"
      icon={<ResourceIcon kind="terminal" />}
      status={phase === 'partial' ? <StatusBadge tone="danger"><CircleAlert size={10} /> Queue failed</StatusBadge> : <StatusBadge tone="warning"><CloudOff size={10} /> Portal unreachable</StatusBadge>}
      title="Terminal “storybook”"
    >
      <p className="mt-2 text-[9px] text-muted-foreground"><strong className="text-foreground">Required:</strong> Terminate & close. An unreachable Portal normally accepts an acknowledged termination request.</p>
      {phase === 'partial' ? <p className="mt-1 text-[9px] leading-4 text-destructive">The termination request could not be queued. Terminal state is still unknown, so the Workspace Tab remains.</p> : null}
    </ResourceRow> : null}
  </div>
);

const UnavailableTarget = ({ compact = false }: { compact?: boolean }) => (
  <div className={cn('rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5', compact ? 'p-2.5' : 'p-3')}>
    <div className="flex items-start gap-2">
      <CloudOff className="mt-0.5 shrink-0 text-amber-300" size={15} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5"><span className="text-[11px] font-medium">Unavailable Pane State</span><StatusBadge tone="warning">Target unresolved</StatusBadge></div>
        <p className="mt-1 text-[9px] leading-4 text-muted-foreground">Terminal session terminal_7 still owns this Pane identity and layout position. It is never recreated by name.</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <ChoicePill active={false} onClick={() => undefined}>Retry target</ChoicePill>
          <ChoicePill active={false} onClick={() => undefined}>Locate / rebind</ChoicePill>
          <ChoicePill active={false} onClick={() => undefined}>Replace Pane with…</ChoicePill>
          <ChoicePill active={false} onClick={() => undefined}>Close Pane</ChoicePill>
        </div>
      </div>
    </div>
  </div>
);

const PartialFailureBanner = ({ onRetry }: { onRetry: () => void }) => (
  <div aria-live="assertive" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3" role="alert">
    <div className="flex items-start gap-2">
      <ShieldAlert className="mt-0.5 shrink-0 text-destructive" size={16} />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold">2 of 5 actions need attention. Nothing was removed.</p>
        <p className="mt-1 text-[9px] leading-4 text-muted-foreground">The Thread was stopped and archived. The file save and Terminal termination request failed. Completed work will not be repeated.</p>
        <Button className="mt-2" onClick={onRetry} size="sm"><RotateCcw size={13} /> Retry unresolved actions</Button>
      </div>
    </div>
  </div>
);

const ConsequenceSummary = ({ choices, scope }: { choices: Record<string, BufferChoice>; scope: CloseScope }) => {
  const counts = useMemo(() => Object.values(choices).reduce<Record<string, number>>((result, choice) => {
    result[choice] = (result[choice] ?? 0) + 1;
    return result;
  }, {}), [choices]);
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/35 p-3">
      <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">After resolution</p>
      <ul className="space-y-1.5 text-[10px] leading-4">
        {scope !== 'pane' ? <li className="flex gap-2"><Archive className="mt-0.5 shrink-0" size={12} /><span>1 running Thread stops and is archived</span></li> : null}
        {scope !== 'pane' ? <li className="flex gap-2"><SquareTerminal className="mt-0.5 shrink-0" size={12} /><span>1 Terminal terminates or queues acknowledged termination</span></li> : null}
        {counts.save ? <li className="flex gap-2"><Save className="mt-0.5 shrink-0" size={12} /><span>{counts.save} buffer{counts.save === 1 ? '' : 's'} saved</span></li> : null}
        {counts.draft ? <li className="flex gap-2"><History className="mt-0.5 shrink-0" size={12} /><span>{counts.draft} Recovery Draft{counts.draft === 1 ? '' : 's'} kept</span></li> : null}
        {counts.export ? <li className="flex gap-2"><HardDriveDownload className="mt-0.5 shrink-0" size={12} /><span>{counts.export} draft or buffer exported outside the Workspace</span></li> : null}
        {counts.discard ? <li className="flex gap-2 text-destructive"><Trash2 className="mt-0.5 shrink-0" size={12} /><span>{counts.discard} recoverable item{counts.discard === 1 ? '' : 's'} permanently discarded</span></li> : null}
      </ul>
      <div className="border-t border-border pt-2 text-[9px] leading-4 text-muted-foreground">{scopeCopy[scope].consequence}</div>
    </div>
  );
};

const DialogFrame = ({
  children,
  labelledBy,
  onCancel,
  variant,
}: {
  children: ReactNode;
  labelledBy: string;
  onCancel: () => void;
  variant: VariantKey;
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('[data-autofocus], button')?.focus();
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
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
    <div className={cn('absolute inset-0 z-40 bg-black/65', variant === 'C' ? 'flex justify-end' : 'grid place-items-center p-2 sm:p-5')} onMouseDown={onCancel}>
      <div
        ref={dialogRef}
        aria-labelledby={labelledBy}
        aria-modal="true"
        className={cn(
          'flex max-h-full min-h-0 flex-col overflow-hidden border border-border bg-popover shadow-2xl outline-none',
          variant === 'A' && 'h-[min(760px,calc(100%-8px))] w-[min(1060px,calc(100%-8px))] rounded-xl max-sm:h-full max-sm:w-full max-sm:rounded-none',
          variant === 'B' && 'h-[min(700px,calc(100%-8px))] w-[min(840px,calc(100%-8px))] rounded-xl max-sm:h-full max-sm:w-full max-sm:rounded-none',
          variant === 'C' && 'h-full w-[min(520px,100%)] border-y-0 border-r-0',
        )}
        onKeyDown={handleKeyDown}
        onMouseDown={event => event.stopPropagation()}
        role="dialog"
      >
        {children}
      </div>
    </div>
  );
};

type TransactionViewProps = {
  choices: Record<string, BufferChoice>;
  onCancel: () => void;
  onChoice: (id: string, choice: BufferChoice) => void;
  onResolve: () => void;
  onRetry: () => void;
  phase: TransactionPhase;
  scope: CloseScope;
};

const ImpactLedger = ({ choices, onCancel, onChoice, onResolve, onRetry, phase, scope }: TransactionViewProps) => (
  <>
    <div className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-3 sm:px-5 sm:py-4">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-amber-500/12 text-amber-300"><AlertTriangle size={18} /></span>
      <div className="min-w-0 flex-1">
        <p className="text-[9px] font-semibold uppercase tracking-widest text-amber-300">Close Transaction · {scope}</p>
        <h2 className="mt-0.5 text-sm font-semibold" id="close-transaction-title">Review impact before {scope === 'workspace' ? 'removing' : 'closing'}</h2>
        <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{scopeCopy[scope].target}</p>
      </div>
      <Button aria-label="Cancel Close Transaction" onClick={onCancel} size="icon-sm" variant="ghost"><X size={15} /></Button>
    </div>
    <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_270px]">
      <div className="min-h-0 overflow-auto p-4 sm:p-5">
        {phase === 'partial' ? <div className="mb-4"><PartialFailureBanner onRetry={onRetry} /></div> : null}
        <section aria-labelledby="editor-impact-heading">
          <div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground" id="editor-impact-heading">Editor buffers · choose each</h3><StatusBadge tone="warning">{scopeBuffers(scope).length} affected</StatusBadge></div>
          <EditorResources choices={choices} onChoice={onChoice} phase={phase} scope={scope} />
        </section>
        {scope !== 'pane' ? <section aria-labelledby="required-impact-heading" className="mt-5"><h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground" id="required-impact-heading">Required lifecycle actions</h3><RequiredResources phase={phase} scope={scope} /></section> : null}
        <section className="mt-5"><h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Unavailable target recovery</h3><UnavailableTarget /></section>
      </div>
      <aside className="min-h-0 overflow-auto border-t border-border bg-muted/15 p-4 md:border-l md:border-t-0">
        <ConsequenceSummary choices={choices} scope={scope} />
        <div className="mt-3 rounded-lg border border-border p-3 text-[9px] leading-4 text-muted-foreground"><strong className="text-foreground">Atomic boundary:</strong> shared structure is removed only after every required action succeeds and the Composition Revision plus dirty state are revalidated.</div>
      </aside>
    </div>
    <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
      <p className="text-[9px] text-muted-foreground">Cancel changes nothing and returns focus to {scopeCopy[scope].label}.</p>
      <div className="flex gap-2"><Button onClick={onCancel} variant="outline">Cancel</Button><Button data-autofocus onClick={phase === 'partial' ? onRetry : onResolve}>{phase === 'partial' ? <><RotateCcw size={13} /> Retry unresolved</> : <>Resolve &amp; {scope === 'workspace' ? 'Remove' : 'Close'}</>}</Button></div>
    </footer>
  </>
);

const guidedSteps = ['Editors', 'Thread', 'Terminal', 'Review'] as const;

const GuidedResolution = (props: TransactionViewProps) => {
  const { choices, onCancel, onChoice, onResolve, onRetry, phase, scope } = props;
  const availableSteps = scope === 'pane' ? ['Editors', 'Review'] as const : guidedSteps;
  const [stepIndex, setStepIndex] = useState(0);
  const step = availableSteps[stepIndex];

  useEffect(() => {
    if (phase === 'partial') setStepIndex(availableSteps.length - 1);
  }, [availableSteps.length, phase]);

  return (
    <>
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3 sm:px-5">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary"><LoaderCircle size={18} /></span>
        <div className="min-w-0 flex-1"><p className="text-[9px] font-semibold uppercase tracking-widest text-primary">Guided Close Transaction</p><h2 className="truncate text-sm font-semibold" id="close-transaction-title">{scopeCopy[scope].target}</h2></div>
        <Button aria-label="Cancel Close Transaction" onClick={onCancel} size="icon-sm" variant="ghost"><X size={15} /></Button>
      </div>
      <div className="grid min-h-0 flex-1 sm:grid-cols-[180px_minmax(0,1fr)]">
        <nav aria-label="Close Transaction progress" className="flex gap-1 overflow-auto border-b border-border bg-muted/20 p-2 sm:flex-col sm:border-b-0 sm:border-r sm:p-3">
          {availableSteps.map((label, index) => (
            <button
              key={label}
              aria-current={index === stepIndex ? 'step' : undefined}
              className={cn('flex min-w-max items-center gap-2 rounded-md px-2.5 py-2 text-left text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-ring', index === stepIndex ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted')}
              onClick={() => setStepIndex(index)}
              type="button"
            >
              <span className={cn('grid size-5 place-items-center rounded-full border text-[9px]', index < stepIndex ? 'border-emerald-400 bg-emerald-400/15 text-emerald-300' : index === stepIndex ? 'border-primary' : 'border-border')}>{index < stepIndex ? <Check size={11} /> : index + 1}</span>{label}
            </button>
          ))}
        </nav>
        <div className="min-h-0 overflow-auto p-4 sm:p-5">
          {step === 'Editors' ? <section><p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">Step {stepIndex + 1} · recoverable content</p><h3 className="mt-1 text-base font-semibold">Choose what happens to each buffer</h3><p className="mt-1 mb-4 text-[10px] leading-4 text-muted-foreground">Remote ownership and disconnected drafts remain visible. Nothing is assumed clean because a client went offline.</p><EditorResources choices={choices} onChoice={onChoice} phase={phase} scope={scope} /></section> : null}
          {step === 'Thread' ? <section><p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">Step {stepIndex + 1} · execution</p><h3 className="mt-1 text-base font-semibold">Stop and archive the running Thread</h3><p className="mt-1 mb-4 text-[10px] leading-4 text-muted-foreground">Closing ends the Pane but does not permanently delete the Thread.</p><RequiredResources only="thread" phase={phase} scope="tab" /></section> : null}
          {step === 'Terminal' ? <section><p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">Step {stepIndex + 1} · remote process</p><h3 className="mt-1 text-base font-semibold">Terminate the non-idle Terminal</h3><p className="mt-1 mb-4 text-[10px] leading-4 text-muted-foreground">The Portal is unreachable. Queue an acknowledged termination request; unknown state never counts as idle.</p><ResourceRow detail="Non-idle shell · job: bun run storybook · Portal bazzite is unreachable" icon={<ResourceIcon kind="terminal" />} status={phase === 'partial' ? <StatusBadge tone="danger">Queue failed</StatusBadge> : <StatusBadge tone="warning">Required</StatusBadge>} title="Terminal “storybook”" /><div className="mt-4"><UnavailableTarget /></div></section> : null}
          {step === 'Review' ? <section><p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">Final step · revalidate</p><h3 className="mt-1 text-base font-semibold">Review the complete outcome</h3><p className="mt-1 mb-4 text-[10px] leading-4 text-muted-foreground">One primary action coordinates the choices; it does not pretend side effects are reversible.</p>{phase === 'partial' ? <div className="mb-4"><PartialFailureBanner onRetry={onRetry} /></div> : null}<ConsequenceSummary choices={choices} scope={scope} /></section> : null}
        </div>
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-3">
        <Button disabled={stepIndex === 0} onClick={() => setStepIndex(index => Math.max(0, index - 1))} variant="ghost"><ChevronLeft size={13} /> Back</Button>
        <p className="hidden text-[9px] text-muted-foreground sm:block">{stepIndex + 1} of {availableSteps.length}</p>
        {stepIndex < availableSteps.length - 1
          ? <Button data-autofocus onClick={() => setStepIndex(index => index + 1)}>Continue <ChevronRight size={13} /></Button>
          : <Button data-autofocus onClick={phase === 'partial' ? onRetry : onResolve}>{phase === 'partial' ? 'Retry unresolved' : `Resolve & ${scope === 'workspace' ? 'Remove' : 'Close'}`}</Button>}
      </footer>
    </>
  );
};

const RecoveryDrawer = ({ choices, onCancel, onChoice, onResolve, onRetry, phase, scope }: TransactionViewProps) => (
  <>
    <div className="shrink-0 border-b border-border p-4">
      <div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-amber-500/12 text-amber-300"><PanelRightClose size={18} /></span><div className="min-w-0 flex-1"><p className="text-[9px] font-semibold uppercase tracking-widest text-amber-300">Recovery drawer · {scope}</p><h2 className="mt-0.5 text-sm font-semibold" id="close-transaction-title">Keep the impact in context</h2><p className="mt-1 text-[10px] text-muted-foreground">{scopeCopy[scope].target}</p></div><Button aria-label="Cancel Close Transaction" onClick={onCancel} size="icon-sm" variant="ghost"><X size={15} /></Button></div>
      <div className="mt-3 flex flex-wrap gap-1.5"><StatusBadge tone="warning">{scopeBuffers(scope).length} buffers</StatusBadge>{scope !== 'pane' ? <><StatusBadge tone="warning">1 running Thread</StatusBadge><StatusBadge tone="warning">1 non-idle Terminal</StatusBadge></> : null}</div>
    </div>
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
      {phase === 'partial' ? <PartialFailureBanner onRetry={onRetry} /> : null}
      <section><h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Keep, save, export, or discard</h3><EditorResources choices={choices} onChoice={onChoice} phase={phase} scope={scope} /></section>
      {scope !== 'pane' ? <section><h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Required before removal</h3><RequiredResources phase={phase} scope={scope} /></section> : null}
      <section><h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Pane still has a place</h3><UnavailableTarget compact /></section>
      <ConsequenceSummary choices={choices} scope={scope} />
    </div>
    <footer className="shrink-0 border-t border-border p-4">
      <p className="mb-3 text-[9px] leading-4 text-muted-foreground">Resolve only removes shared structure after revalidation. On failure, the drawer stays attached to the still-existing target.</p>
      <div className="grid grid-cols-2 gap-2"><Button onClick={onCancel} variant="outline">Cancel</Button><Button data-autofocus onClick={phase === 'partial' ? onRetry : onResolve}>{phase === 'partial' ? 'Retry unresolved' : `Resolve & ${scope === 'workspace' ? 'Remove' : 'Close'}`}</Button></div>
    </footer>
  </>
);

const PaneCard = ({
  dirty,
  icon,
  onClose,
  subtitle,
  title,
}: {
  dirty?: string;
  icon: ReactNode;
  onClose?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  subtitle: string;
  title: string;
}) => (
  <section aria-label={`${title} Pane`} className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-background shadow-sm">
    <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-muted/25 px-2.5"><span className="text-muted-foreground">{icon}</span><span className="min-w-0 flex-1 truncate text-[10px] font-medium">{title}</span>{dirty ? <StatusBadge tone="warning">{dirty}</StatusBadge> : null}{onClose ? <button aria-label={`Close Pane ${title}`} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onClose} type="button"><X size={12} /></button> : null}</header>
    <div className="min-h-0 flex-1 overflow-hidden p-3 text-[9px] leading-4 text-muted-foreground">
      {title.includes('Thread') ? <><p className="rounded-lg bg-muted p-2 text-foreground">Prototype the close contract against the hard cases.</p><p className="ml-auto mt-2 max-w-[88%] rounded-lg bg-primary/15 p-2">Show completed side effects when a retry is needed.</p></> : null}
      {title.endsWith('.ts') ? <pre className="font-mono"><code><span className="text-primary">type</span> CloseTransaction = {'{'}{`\n`}  revision: number;{`\n`}  actions: Action[];{`\n`}{'}'};</code></pre> : null}
      {title.includes('Terminal') ? <pre className="font-mono"><code>$ bun run storybook{`\n`}<span className="text-amber-300">running</span> · Portal heartbeat lost</code></pre> : null}
      <p className="mt-2 truncate">{subtitle}</p>
    </div>
  </section>
);

const WorkbenchFixture = ({
  onOpen,
  phase,
}: {
  onOpen: (scope: CloseScope, trigger: HTMLButtonElement) => void;
  phase: TransactionPhase;
}) => {
  const trigger = (scope: CloseScope) => (event: React.MouseEvent<HTMLButtonElement>) => onOpen(scope, event.currentTarget);
  return (
    <div className="flex h-full min-h-[640px] flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-3"><span className="grid size-7 place-items-center rounded-md bg-primary text-[10px] font-bold text-primary-foreground">W</span><div className="min-w-0 flex-1"><p className="truncate text-[11px] font-semibold">Weave / main</p><p className="truncate text-[8px] text-muted-foreground">Workspace · composition revision 74</p></div><Button onClick={trigger('workspace')} size="sm" variant="outline"><Trash2 size={12} /> Remove Workspace</Button></header>
      <div className="flex min-h-0 flex-1">
        <aside aria-label="Global Threads" className="hidden w-44 shrink-0 border-r border-border bg-muted/10 p-2 md:block"><div className="mb-2 px-2 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">Threads</div><button className="flex w-full items-center gap-2 rounded-md bg-primary/10 px-2 py-2 text-left text-[9px] text-primary" type="button"><Bot size={13} /><span className="min-w-0 flex-1 truncate">Prototype close recovery</span><span className="size-1.5 rounded-full bg-emerald-400" /></button></aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-end gap-1 border-b border-border bg-muted/10 px-2"><button aria-current="page" className="flex h-8 min-w-0 items-center gap-2 rounded-t-md border border-b-background border-border bg-background px-3 text-[10px]" type="button"><span className="truncate">Recovery design</span><StatusBadge tone="warning">Dirty</StatusBadge></button><Button aria-label="Close final Workspace Tab Recovery design" className="mb-1 ml-auto" onClick={trigger('tab')} size="icon-sm" variant="ghost"><X size={13} /></Button></div>
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-1 bg-muted/25 p-1 sm:grid-cols-2 sm:grid-rows-2">
            <PaneCard dirty="Running" icon={<MessageSquare size={13} />} subtitle="Thread Pane · server-authoritative run state" title="Thread · Prototype close recovery" />
            <PaneCard dirty="2 buffers" icon={<FileCode2 size={13} />} onClose={trigger('pane')} subtitle="Editor Pane · Preferred Editor Pane" title="shell-state.ts" />
            <div className="sm:col-span-2"><PaneCard dirty="Unknown" icon={<SquareTerminal size={13} />} subtitle="Terminal Pane · non-idle · Portal unreachable" title="Terminal · storybook" /></div>
          </div>
        </main>
        <aside aria-label="Workspace files" className="hidden w-52 shrink-0 border-l border-border bg-muted/10 p-2 lg:block"><div className="flex items-center gap-2 border-b border-border px-1 pb-2 text-[9px] font-semibold uppercase tracking-widest"><Files size={12} />Workspace files</div><div className="mt-2 flex items-center gap-1 text-[9px]"><FolderOpen size={11} className="text-primary" />packages/client/src</div><div className="mt-1 space-y-1 pl-3 text-[8px] text-muted-foreground"><p>stores/shell-state.ts *</p><p>app-shell/close-review.tsx</p></div></aside>
      </div>
      {phase === 'resolved' ? <div className="absolute inset-x-4 top-16 z-20 rounded-lg border border-emerald-500/40 bg-emerald-950/95 p-3 text-emerald-100 shadow-xl" role="status"><div className="flex items-start gap-2"><Check className="mt-0.5" size={15} /><div><p className="text-[11px] font-semibold">Close Transaction complete</p><p className="mt-0.5 text-[9px]">Shared structure was removed after revision and dirty-state revalidation. Focus returned to the nearest surviving shell landmark.</p></div></div></div> : null}
    </div>
  );
};

const PrototypeSwitcher = ({ current, onChange }: { current: VariantKey; onChange: (key: VariantKey) => void }) => {
  const index = variants.findIndex(variant => variant.key === current);
  const cycle = useCallback((direction: -1 | 1) => onChange(variants[(index + direction + variants.length) % variants.length].key), [index, onChange]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft') cycle(-1);
      if (event.key === 'ArrowRight') cycle(1);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [cycle]);

  return (
    <div aria-label="Prototype variants" className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/15 bg-zinc-950/95 p-1 text-white shadow-2xl" role="group">
      <button aria-label="Previous prototype variant" className="grid size-8 place-items-center rounded-full hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white" onClick={() => cycle(-1)} type="button"><ChevronLeft size={14} /></button>
      <div className="min-w-[180px] px-2 text-center"><p className="text-[10px] font-semibold">{variants[index].key} — {variants[index].name}</p><p className="text-[8px] text-zinc-400">{variants[index].summary}</p></div>
      <button aria-label="Next prototype variant" className="grid size-8 place-items-center rounded-full hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white" onClick={() => cycle(1)} type="button"><ChevronRight size={14} /></button>
    </div>
  );
};

const CloseRecoveryPrototype = ({ initialScope = 'tab' }: { initialScope?: CloseScope }) => {
  const params = new URLSearchParams(window.location.search);
  const initialVariant = params.get('variant');
  const [variant, setVariant] = useState<VariantKey>(initialVariant === 'B' || initialVariant === 'C' ? initialVariant : 'A');
  const [scope, setScope] = useState<CloseScope>(initialScope);
  const [choices, setChoices] = useState<Record<string, BufferChoice>>(() => initialChoices(initialScope));
  const [phase, setPhase] = useState<TransactionPhase>('review');
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('Ready. Choose a close target to review its impact.');
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);

  const changeVariant = useCallback((next: VariantKey) => {
    const url = new URL(window.location.href);
    url.searchParams.set('variant', next);
    window.history.replaceState({}, '', url);
    setVariant(next);
    setAnnouncement(`Showing ${variants.find(item => item.key === next)?.name} prototype variant.`);
  }, []);

  const openTransaction = (nextScope: CloseScope, trigger: HTMLButtonElement) => {
    returnFocusRef.current = trigger;
    setScope(nextScope);
    setChoices(initialChoices(nextScope));
    setPhase('review');
    setOpen(true);
    setAnnouncement(`${scopeCopy[nextScope].label} impact review opened. ${scopeBuffers(nextScope).length} buffers require a choice.`);
  };

  const cancel = () => {
    setOpen(false);
    setPhase('review');
    setAnnouncement('Close Transaction canceled. No resource or shared structure changed.');
    window.setTimeout(() => returnFocusRef.current?.focus(), 0);
  };

  const resolve = () => {
    setPhase('partial');
    setAnnouncement('Close Transaction partially failed. The Thread was archived; file save and Terminal termination remain unresolved. Nothing was removed.');
  };

  const retry = () => {
    setOpen(false);
    setPhase('resolved');
    setAnnouncement(scope === 'tab' ? 'Close Transaction complete. A fresh empty New Tab was created and focus moved to it.' : 'Close Transaction complete. Shared structure was removed and focus moved to the nearest surviving shell landmark.');
    window.setTimeout(() => returnFocusRef.current?.focus(), 0);
  };

  const viewProps: TransactionViewProps = {
    choices,
    onCancel: cancel,
    onChoice: (id, choice) => setChoices(current => ({ ...current, [id]: choice })),
    onResolve: resolve,
    onRetry: retry,
    phase,
    scope,
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <WorkbenchFixture onOpen={openTransaction} phase={phase} />
      {open ? (
        <DialogFrame labelledBy="close-transaction-title" onCancel={cancel} variant={variant}>
          {variant === 'A' ? <ImpactLedger {...viewProps} /> : variant === 'B' ? <GuidedResolution {...viewProps} /> : <RecoveryDrawer {...viewProps} />}
        </DialogFrame>
      ) : null}
      <div aria-atomic="true" aria-live="polite" className="sr-only" data-testid="close-announcement">{announcement}</div>
      {import.meta.env.MODE !== 'production' ? <PrototypeSwitcher current={variant} onChange={changeVariant} /> : null}
    </div>
  );
};

const meta = {
  title: 'Prototypes/Dirty Close Recovery',
  component: CloseRecoveryPrototype,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof CloseRecoveryPrototype>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ManualReview: Story = {
  args: { initialScope: 'tab' },
};

export const FinalWorkspaceTab: Story = {
  args: { initialScope: 'tab' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Close final Workspace Tab Recovery design' }));
    await expect(canvas.getByRole('dialog', { name: 'Review impact before closing' })).toBeVisible();
    await expect(canvas.getByText('This is the final Workspace Tab. A fresh empty “New Tab” will be created after closing succeeds.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Resolve & Close' }));
    await expect(canvas.getByRole('alert')).toHaveTextContent('Nothing was removed');
    await userEvent.click(canvas.getByRole('button', { name: 'Retry unresolved actions' }));
    await waitFor(() => expect(canvas.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(canvas.getByRole('status')).toHaveTextContent('Close Transaction complete');
  },
};

export const RemoveWorkspace: Story = {
  args: { initialScope: 'workspace' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Remove Workspace' }));
    await expect(canvas.getByText('docs/close-recovery-notes.md')).toBeVisible();
    await expect(canvas.getAllByRole('button', { name: 'Export outside Workspace' }).find(button => button.getAttribute('aria-pressed') === 'true')).toBeDefined();
  },
};

export const CloseEditorPane: Story = {
  args: { initialScope: 'pane' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Close Pane shell-state.ts' }));
    await expect(canvas.queryByText('Required lifecycle actions')).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
    await expect(canvas.getByRole('button', { name: 'Close Pane shell-state.ts' })).toHaveFocus();
    await expect(canvas.getByTestId('close-announcement')).toHaveTextContent('No resource or shared structure changed');
  },
};
