import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon } from '@hugeicons/core-free-icons';
import type { BotSummary } from '@/app/app-controller';
import { BotAvatar } from '@/components/bots/bot-avatar';
import { BotStateDot } from '@/components/bots/bot-list';
import { botRowState, botStateLabel } from '@/session/bots';

/**
 * A Bot's name and what it's doing, atop its Session in place of tabs, a pill as tall as theirs and
 * as wide as it needs: it leads to the Bot's page.
 */
export function BotHeading({ bot, unread, onOpen }: { bot: BotSummary; unread: ReadonlySet<string>; onOpen?(): void }) {
  const state = botRowState(bot, unread);
  const label = bot.startingThread ? 'starting a new thread' : state === 'idle' && !bot.thread ? 'no thread yet' : botStateLabel[state];
  return (
    <button type='button' data-slot='bot-heading' aria-label={`${bot.name}, ${label}: about this Bot`} title='About this Bot'
      className='flex h-9 max-w-full min-w-0 items-center gap-2 rounded-full bg-muted/50 pr-2.5 pl-1.5 text-left outline-none hover:bg-muted focus-visible:bg-muted'
      onClick={onOpen}>
      <BotAvatar bot={bot} size='sm' className='border-border bg-muted text-foreground/80'>
        <BotStateDot state={state} className='absolute -top-0.5 -right-0.5 size-2 ring-2 ring-title-bar' />
      </BotAvatar>
      {/* The name keeps its room; what it's doing gives way first. */}
      <span className='max-w-[65%] shrink-0 truncate text-sm font-semibold'>{bot.name}</span>
      <span className='min-w-0 truncate text-[0.6875rem] text-muted-foreground'>· {label}</span>
      <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className='size-3.5 shrink-0 text-icon-muted' aria-hidden />
    </button>
  );
}
