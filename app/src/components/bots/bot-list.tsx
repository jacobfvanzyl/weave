// The Bots in the list of Sessions (WVE-178): a group above the Projects, a row for each Bot, as a
// chat app lists its conversations, with what it's doing. A Bot's Session is listed here only.
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, BotIcon } from '@hugeicons/core-free-icons';
import type { BotSummary } from '@/app/app-controller';
import { SidebarGroup, SidebarGroupAction, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { type BotRowState, botRowState, botStateLabel } from '@/session/bots';

const dots: Record<BotRowState, string | undefined> = {
  needsYou: 'bg-warning',
  working: 'bg-info motion-safe:animate-pulse',
  unread: 'bg-success',
  away: undefined,
  idle: undefined,
};

/** A Bot's state as a dot, as a thread's activity shows: needs you, working, or unread. */
export function BotStateDot({ state, className }: { state: BotRowState; className?: string }) {
  const color = dots[state];
  if (!color) return null;
  return (
    <span role='img' aria-label={botStateLabel[state]} title={botStateLabel[state]} data-slot='bot-state' data-state={state}
      className={cn('size-2 shrink-0 rounded-full', className)}>
      <span aria-hidden='true' className={cn('block size-full rounded-full', color)} />
    </span>
  );
}

/** One Bot: its name, and what it's doing, or that its Host is away. */
function BotRow({ bot, unread, selected, onOpen }: { bot: BotSummary; unread: ReadonlySet<string>; selected: boolean; onOpen(): void }) {
  const state = botRowState(bot, unread);
  const detail = [
    bot.startingThread ? 'starting a new thread' : state === 'idle' && !bot.thread ? 'no thread yet' : botStateLabel[state],
    ...(bot.paused ? ['paused'] : []),
  ].join(' · ');
  return (
    <SidebarMenuItem>
      <SidebarMenuButton size='lg' isActive={selected} aria-current={selected ? 'page' : undefined} data-bot-state={state}
        className={cn('h-auto min-h-11 gap-2.5 rounded-xl border border-transparent py-1.5 pl-1.5 data-active:border-sidebar-border', state === 'away' && 'opacity-60')}
        title={state === 'away' ? `${bot.hostName} isn't connected to the Dispatcher.` : undefined}
        onClick={onOpen}>
        <span className='relative grid size-7 shrink-0 place-items-center rounded-full border border-sidebar-border bg-sidebar-accent text-sidebar-foreground/80'>
          <HugeiconsIcon icon={BotIcon} strokeWidth={2} className='size-3.5!' aria-hidden />
          <BotStateDot state={state} className='absolute -top-0.5 -right-0.5 size-2.5 ring-2 ring-sidebar' />
        </span>
        <span className='flex min-w-0 flex-1 flex-col gap-0.5'>
          <span className={cn('truncate text-sidebar-foreground', state === 'unread' || state === 'needsYou' ? 'font-semibold' : 'font-medium')}>{bot.name}</span>
          <span className={cn('truncate text-[0.6875rem]', state === 'needsYou' ? 'text-warning' : 'text-muted-foreground')}>{detail}</span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * The Bots, by name, above the Projects: shown whenever the Dispatcher keeps Bots, with New Bot
 * where it makes their homes (`bots_home`). Filtered with the Sessions, by name and Host.
 */
export function BotList({ bots, unread, canAdd, canStart, query, selected, onOpen, onNewBot }: {
  bots: readonly BotSummary[];
  unread: ReadonlySet<string>;
  /** The Dispatcher makes a new Bot's home. */
  canAdd: boolean;
  /** A Host is connected to start one on. */
  canStart: boolean;
  query: string;
  /** The Bot on screen, by id. */
  selected?: string;
  onOpen(id: string): void;
  onNewBot(): void;
}) {
  const filter = query.trim().toLocaleLowerCase();
  const shown = filter ? bots.filter((bot) => [bot.name, bot.hostName].some((value) => value.toLocaleLowerCase().includes(filter))) : bots;
  if (filter && shown.length === 0) return null;
  return (
    <SidebarGroup role='group' aria-label='Bots' data-slot='bot-list' className='py-1.5'>
      <SidebarGroupLabel className='h-9 gap-2 pr-9 text-sm font-medium text-sidebar-foreground [&>svg]:size-4.5'>
        <HugeiconsIcon icon={BotIcon} strokeWidth={1.75} className='text-icon-muted' aria-hidden />
        <span className='min-w-0 truncate'>Bots</span>
      </SidebarGroupLabel>
      {canAdd && (
        <SidebarGroupAction aria-label='New Bot' title='New Bot' className='top-3.5 right-2.5' disabled={!canStart} onClick={onNewBot}>
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
        </SidebarGroupAction>
      )}
      <SidebarMenu className='gap-0.5'>
        {shown.map((bot) => <BotRow key={bot.id} bot={bot} unread={unread} selected={bot.id === selected} onOpen={() => onOpen(bot.id)} />)}
      </SidebarMenu>
      {bots.length === 0 && (
        <p className='px-2 pb-1 text-[0.6875rem] text-muted-foreground'>
          {canAdd ? 'No Bots yet. A Bot is an assistant you come back to by name, with a home on one of your Hosts.' : 'No Bots yet.'}
        </p>
      )}
    </SidebarGroup>
  );
}
