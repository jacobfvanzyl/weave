// New Block (WVE-220): what a Block shows, picked in one step. A thread to start with one of the
// Host's agents, a terminal to start, or a thread or terminal there is that no Block shows.
// Typing narrows the list, the arrows move, and Return picks, as in the command palette.
import { useEffect, useState, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown01Icon, BubbleChatIcon, ComputerTerminal01Icon } from '@hugeicons/core-free-icons';
import type { AgentChoice, TerminalSummary, ThreadSummary } from '@/app/app-controller';
import { lastUsedFirst, loadLastChoices } from '@/app/last-choices';
import { TerminalMark } from '@/components/session/blocks';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { terminalName } from '@/terminal/terminals';

type Row = {
  id: string;
  icon: typeof BubbleChatIcon;
  label: string;
  /** What's said after it, and searched with it. */
  detail?: string;
  mark?: ReactNode;
  run(): void;
};

type Section = {
  name: 'New' | 'Not shown' | 'Elsewhere' | 'Closed';
  rows: Row[];
  /** Kept behind a row with its count until asked for, or searched. */
  folds?: boolean;
  /** What it says when it has nothing. */
  none?: string;
};

const activityOf = (thread: ThreadSummary) => thread.activity === 'waiting' ? 'waiting on you' : thread.activity === 'running' ? 'running' : thread.agentName;

export function NewBlockDialog({ open, onOpenChange, agents, threads, closed, terminals, elsewhere, canTerminals, onNewThread, onNewTerminal, onThread, onTerminal }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The agents a thread may start with here; none in a Bot's Session, whose one thread is its own. */
  agents: readonly AgentChoice[];
  /** The Session's open threads no Block shows, and its closed ones, which open again here. */
  threads: ThreadSummary[];
  closed: ThreadSummary[];
  terminals: TerminalSummary[];
  /** What's in its directory and not the Session's, which a Block brings into it: started from a terminal, a schedule or another client. */
  elsewhere: { threads: ThreadSummary[]; terminals: TerminalSummary[] };
  canTerminals: boolean;
  onNewThread(agentId: string): void;
  onNewTerminal(): void;
  onThread(thread: ThreadSummary): void;
  onTerminal(terminal: TerminalSummary): void;
}) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(0);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  // The agent this device started a thread with last comes first.
  const [lastAgent, setLastAgent] = useState<string>();
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setPicked(0);
    setUnfolded(new Set());
    setLastAgent(loadLastChoices().agentId);
  }, [open]);
  useEffect(() => setPicked(0), [query]);

  const threadRow = (thread: ThreadSummary, detail = activityOf(thread)): Row =>
    ({ id: `thread-${thread.key}`, icon: BubbleChatIcon, label: thread.title || 'New thread', detail, run: () => onThread(thread) });
  const terminalRow = (terminal: TerminalSummary): Row =>
    ({ id: `terminal-${terminal.id}`, icon: ComputerTerminal01Icon, label: terminalName(terminal), mark: <TerminalMark terminal={terminal} />, run: () => onTerminal(terminal) });
  const canThreads = agents.length > 0;
  const sections: Section[] = [
    {
      name: 'New',
      rows: [
        ...lastUsedFirst(agents, lastAgent).map((agent): Row => ({ id: `new-${agent.id}`, icon: BubbleChatIcon, label: `New thread with ${agent.name}`, run: () => onNewThread(agent.id) })),
        ...(canTerminals ? [{ id: 'new-terminal', icon: ComputerTerminal01Icon, label: 'New terminal', run: onNewTerminal }] : []),
      ],
    },
    {
      name: 'Not shown',
      rows: [...threads.map((thread) => threadRow(thread)), ...terminals.map(terminalRow)],
      none: canThreads ? 'Every open thread and terminal here has a Block.' : 'Every terminal here has a Block.',
    },
    { name: 'Elsewhere', rows: [...elsewhere.threads.map((thread) => threadRow(thread)), ...elsewhere.terminals.map(terminalRow)], folds: true },
    { name: 'Closed', rows: closed.map((thread) => threadRow(thread, thread.agentName)), folds: true },
  ];

  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const shown = sections.flatMap((section): Section[] => {
    if (words.length > 0) {
      const rows = section.rows.filter(({ label, detail }) => words.every((word) => `${label} ${detail ?? ''}`.toLocaleLowerCase().includes(word)));
      return rows.length > 0 ? [{ ...section, rows, none: undefined }] : [];
    }
    if (section.rows.length === 0) return section.none ? [section] : [];
    if (!section.folds || unfolded.has(section.name)) return [section];
    // Folded: one row, which opens it.
    const count = section.rows.length;
    return [{
      ...section,
      rows: [{
        id: `fold-${section.name}`,
        icon: ArrowDown01Icon,
        label: `${section.name === 'Closed' ? 'Closed threads' : 'Elsewhere in this directory'}`,
        detail: `${count}`,
        run: () => setUnfolded((current) => new Set([...current, section.name])),
      }],
    }];
  });
  const rows = shown.flatMap((section) => section.rows);
  const at = Math.min(picked, rows.length - 1);
  const active = rows[at];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='top-[20%] w-[min(28rem,calc(100%-2rem))] max-w-none translate-y-0 gap-2 p-2 sm:max-w-md' showCloseButton={false}>
        <DialogHeader className='sr-only'>
          <DialogTitle>New Block</DialogTitle>
          <DialogDescription>What the Block shows: something new, or a thread or terminal no Block shows. Type to find it, then press Return.</DialogDescription>
        </DialogHeader>
        <Input aria-label='Find something to show' placeholder='New Block' autoFocus value={query}
          role='combobox' aria-expanded='true' aria-controls='new-block-list'
          aria-activedescendant={active ? `new-block-${active.id}` : undefined}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setPicked(Math.min(rows.length - 1, at + 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setPicked(Math.max(0, at - 1));
            } else if (event.key === 'Enter' && active) {
              event.preventDefault();
              active.run();
            }
          }} />
        <div id='new-block-list' role='listbox' aria-label='What the Block shows' className='grid max-h-[60dvh] gap-2 overflow-y-auto'>
          {shown.map((section) => (
            <div key={section.name} role='group' aria-label={section.name} className='grid gap-0.5'>
              {section.name !== 'New' && !section.rows[0]?.id.startsWith('fold-') && (
                <p className='px-2 text-[0.6875rem] font-medium text-muted-foreground'>{section.name}</p>
              )}
              {section.rows.length === 0 && <p className='px-2 py-1 text-[0.6875rem] text-muted-foreground'>{section.none}</p>}
              {section.rows.map((row) => (
                <div key={row.id} id={`new-block-${row.id}`} role='option' aria-selected={row === active}
                  aria-expanded={row.id.startsWith('fold-') ? false : undefined}
                  className={cn('flex min-h-8 min-w-0 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs', row === active && 'bg-muted',
                    row.id.startsWith('fold-') && 'text-muted-foreground')}
                  onPointerMove={() => setPicked(rows.indexOf(row))} onClick={row.run}>
                  <HugeiconsIcon icon={row.icon} strokeWidth={2} className='size-3.5 shrink-0 text-icon-muted' aria-hidden />
                  <span className='min-w-0 flex-1 truncate'>{row.label}</span>
                  {row.detail && <span className='shrink-0 text-[0.6875rem] text-muted-foreground'>{row.detail}</span>}
                  {row.mark}
                </div>
              ))}
            </div>
          ))}
          {rows.length === 0 && words.length > 0 && <p className='px-2 py-3 text-center text-xs text-muted-foreground'>Nothing matches.</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
