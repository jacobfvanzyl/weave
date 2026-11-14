// New Block (WVE-220, WVE-229): what a Block shows, picked from a menu at what opened it. A thread
// with one of the Host's agents, a terminal, a closed thread to open again, or a thread or
// terminal in the directory that no Block shows. The arrows move and Return picks, as in any menu.
import type { ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowTurnBackwardIcon, BubbleChatIcon, ComputerTerminal01Icon, Folder01Icon } from '@hugeicons/core-free-icons';
import type { AgentChoice, TerminalSummary, ThreadSummary } from '@/app/app-controller';
import { lastUsedFirst, loadLastChoices } from '@/app/last-choices';
import { TerminalMark } from '@/components/session/blocks';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { terminalName } from '@/terminal/terminals';

/** Where the menu opens: at the button that opened it, or over the Block a key opened it for. */
export type NewBlockAnchor = { element: Element } | { over: () => DOMRect };

type Row = {
  id: string;
  icon: typeof BubbleChatIcon;
  label: string;
  /** What's said after it. */
  detail?: string;
  mark?: ReactNode;
  run(): void;
};

const activityOf = (thread: ThreadSummary) => thread.activity === 'waiting' ? 'waiting on you' : thread.activity === 'running' ? 'running' : thread.agentName;

/** Its top third, the middle of its width: where a menu opened over a Block or a tab sits. */
const overPoint = (rect: () => DOMRect) => ({
  getBoundingClientRect: () => {
    const { left, top, width, height } = rect();
    return new DOMRect(left + width / 2, top + Math.min(height / 3, 160), 0, 0);
  },
});

export function NewBlockMenu({ open, onOpenChange, anchor, agents, threads, closed, terminals, elsewhere, canTerminals, onNewThread, onNewTerminal, onThread, onTerminal }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  anchor?: NewBlockAnchor;
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
  const threadRow = (thread: ThreadSummary, detail = activityOf(thread)): Row =>
    ({ id: `thread-${thread.key}`, icon: BubbleChatIcon, label: thread.title || 'New thread', detail, run: () => onThread(thread) });
  const terminalRow = (terminal: TerminalSummary): Row =>
    ({ id: `terminal-${terminal.id}`, icon: ComputerTerminal01Icon, label: terminalName(terminal), mark: <TerminalMark terminal={terminal} />, run: () => onTerminal(terminal) });
  // The agent this device started a thread with last comes first. Read as it opens.
  const ordered = open ? lastUsedFirst(agents, loadLastChoices().agentId) : agents;
  // The Session's own that no Block shows come first, then what else is open in its directory.
  const directory = [
    ...threads.map((thread) => threadRow(thread)),
    ...terminals.map(terminalRow),
    ...elsewhere.threads.map((thread) => threadRow(thread)),
    ...elsewhere.terminals.map(terminalRow),
  ];
  const reopen = closed.map((thread) => threadRow(thread, thread.agentName));
  const fresh = ordered.length > 0 || canTerminals;
  const more = reopen.length > 0 || directory.length > 0;

  const item = (row: Row) => (
    <DropdownMenuItem key={row.id} onClick={row.run}>
      <HugeiconsIcon icon={row.icon} strokeWidth={2} className='text-icon-muted' aria-hidden />
      <span className='min-w-0 flex-1 truncate'>{row.label}</span>
      {row.detail && <span className='shrink-0 text-[0.6875rem] text-muted-foreground'>{row.detail}</span>}
      {row.mark}
    </DropdownMenuItem>
  );
  const sub = (label: string, icon: typeof BubbleChatIcon, rows: ReactNode) => (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <HugeiconsIcon icon={icon} strokeWidth={2} className='text-icon-muted' aria-hidden />
        {label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent aria-label={label} className='max-w-80 min-w-44'>{rows}</DropdownMenuSubContent>
    </DropdownMenuSub>
  );

  const at = anchor && ('element' in anchor ? anchor.element : overPoint(anchor.over));
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuContent aria-label='New Block' anchor={at} align={anchor && 'over' in anchor ? 'center' : 'start'} className='w-auto min-w-48'>
        {ordered.length > 0 && sub('New thread', BubbleChatIcon, ordered.map((agent) => (
          <DropdownMenuItem key={agent.id} onClick={() => onNewThread(agent.id)}>{agent.name}</DropdownMenuItem>
        )))}
        {canTerminals && (
          <DropdownMenuItem onClick={onNewTerminal}>
            <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={2} className='text-icon-muted' aria-hidden />
            New terminal
          </DropdownMenuItem>
        )}
        {fresh && more && <DropdownMenuSeparator />}
        {reopen.length > 0 && sub('Reopen thread', ArrowTurnBackwardIcon, reopen.map(item))}
        {directory.length > 0 && sub('From this directory', Folder01Icon, directory.map(item))}
        {!fresh && !more && <DropdownMenuItem disabled>Nothing to show here</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
