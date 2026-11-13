// A Bot's avatar (WVE-223): its emoji on its colour, in a circle, wherever the Bot is named, and
// the picker its page opens. A Bot without an emoji shows the robot; one without a colour, the
// neutral circle every Bot had before.
import { useState, type FormEvent, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { BotIcon } from '@hugeicons/core-free-icons';
import type { BotChange, BotSummary } from '@/app/app-controller';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { BotColor } from '@/host/protocol';
import { cn } from '@/lib/utils';
import { BOT_COLORS, BOT_EMOJI, typedEmoji } from '@/session/bots';

/** The colours as Catppuccin Mocha has them; brown, which it hasn't, sits between peach and its surfaces. */
export const botColors: Record<BotColor, string> = {
  white: '#cdd6f4',
  brown: '#b08968',
  red: '#f38ba8',
  orange: '#fab387',
  yellow: '#f9e2af',
  green: '#a6e3a1',
  teal: '#94e2d5',
  blue: '#89b4fa',
  purple: '#cba6f7',
  pink: '#f5c2e7',
  gray: '#7f849c',
};

const sizes = {
  sm: { box: 'size-6', emoji: 'text-[0.8125rem]', icon: 'size-3.5!' },
  md: { box: 'size-7', emoji: 'text-[0.9375rem]', icon: 'size-3.5!' },
  lg: { box: 'size-12', emoji: 'text-[1.625rem]', icon: 'size-6!' },
};

/**
 * A Bot's avatar. `children` sit over it, as its state's dot does at its corner. `className`
 * gives the border and background of one with no colour, which differ by where it is.
 */
export function BotAvatar({ bot, size = 'md', className, children }: {
  bot: Pick<BotSummary, 'emoji' | 'color'>;
  size?: keyof typeof sizes;
  className?: string;
  children?: ReactNode;
}) {
  const { box, emoji, icon } = sizes[size];
  const color = bot.color ? botColors[bot.color] : undefined;
  return (
    <span data-slot='bot-avatar' data-color={bot.color} style={color ? { backgroundColor: color, borderColor: color } : undefined}
      className={cn('relative grid shrink-0 place-items-center rounded-full border', box, color ? 'text-[#11111b]' : className)}>
      {bot.emoji
        ? <span aria-hidden className={cn('leading-none select-none', emoji)}>{bot.emoji}</span>
        : <HugeiconsIcon icon={BotIcon} strokeWidth={2} className={icon} aria-hidden />}
      {children}
    </span>
  );
}

const colorNames: Record<BotColor, string> = {
  white: 'White', brown: 'Brown', red: 'Red', orange: 'Orange', yellow: 'Yellow', green: 'Green',
  teal: 'Teal', blue: 'Blue', purple: 'Purple', pink: 'Pink', gray: 'Gray',
};

/**
 * Picking a Bot's avatar: an emoji from those offered or typed, and a colour. Each pick is saved
 * as it's made; Reset clears both.
 */
export function BotAvatarPicker({ bot, onChange }: { bot: BotSummary; onChange(change: BotChange): void }) {
  const [typed, setTyped] = useState('');
  const emoji = typedEmoji(typed);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!emoji) return;
    onChange({ emoji });
    setTyped('');
  };
  return (
    <div role='group' aria-label={`${bot.name}'s avatar`} data-slot='bot-avatar-picker' className='grid gap-3 rounded-xl border border-border bg-muted/40 p-3'>
      <div role='radiogroup' aria-label='Emoji' className='grid grid-cols-8 gap-1'>
        {BOT_EMOJI.map((choice) => (
          <button key={choice} type='button' role='radio' aria-checked={bot.emoji === choice} aria-label={choice}
            className='grid aspect-square place-items-center rounded-lg text-lg leading-none outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 aria-checked:bg-muted aria-checked:ring-1 aria-checked:ring-border'
            onClick={() => onChange({ emoji: choice })}>
            <span aria-hidden>{choice}</span>
          </button>
        ))}
      </div>
      <form className='flex items-center gap-2' onSubmit={submit}>
        <Input aria-label='Another emoji' placeholder='Another emoji' className='min-w-0 flex-1' value={typed}
          aria-invalid={typed.trim() !== '' && !emoji || undefined} onChange={(event) => setTyped(event.target.value)} />
        <Button type='submit' size='sm' variant='outline' disabled={!emoji}>Use</Button>
      </form>
      <div role='radiogroup' aria-label='Colour' className='flex flex-wrap gap-2'>
        {BOT_COLORS.map((choice) => (
          <button key={choice} type='button' role='radio' aria-checked={bot.color === choice} aria-label={colorNames[choice]} title={colorNames[choice]}
            style={{ backgroundColor: botColors[choice] }}
            className='size-6 rounded-full outline-none ring-offset-2 ring-offset-background focus-visible:ring-2 focus-visible:ring-ring aria-checked:ring-2 aria-checked:ring-foreground/70'
            onClick={() => onChange({ color: choice })} />
        ))}
        <Button type='button' size='sm' variant='ghost' className='ml-auto' disabled={!bot.emoji && !bot.color}
          onClick={() => onChange({ emoji: null, color: null })}>Reset</Button>
      </div>
    </div>
  );
}
