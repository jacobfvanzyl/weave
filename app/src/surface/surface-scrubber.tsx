import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown02Icon } from '@hugeicons/core-free-icons';
import { Button } from '@/components/ui/button';
import type { SurfacePosition } from './surface-messages';

const clamp = (value: number) => Math.max(0, Math.min(1, value));

/**
 * A thin strip on the iPhone's right edge that scrolls the Surface's thread (WVE-183): dragging
 * it scrolls there, and Latest goes back to following the end, which the Surface does until the
 * person scrolls.
 */
export function SurfaceScrubber({ position, onScroll, onFollow }: {
  position?: SurfacePosition;
  onScroll(fraction: number): void;
  onFollow(): void;
}) {
  const track = useRef<HTMLDivElement>(null);
  // Where the person's finger has it, ahead of the Surface saying so.
  const [held, setHeld] = useState<number>();
  const fraction = held ?? position?.fraction ?? 1;
  const following = held === undefined && (position?.following ?? true);
  const scrollable = position?.scrollable ?? false;
  const at = (clientY: number) => {
    const rect = track.current?.getBoundingClientRect();
    return rect && rect.height > 0 ? clamp((clientY - rect.top) / rect.height) : fraction;
  };
  const move = (next: number) => {
    setHeld(next);
    onScroll(next);
  };
  const step = (by: number) => onScroll(clamp(fraction + by));
  const onKeyDown = (event: KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowUp: () => step(-0.05),
      ArrowDown: () => step(0.05),
      PageUp: () => step(-0.2),
      PageDown: () => step(0.2),
      Home: () => onScroll(0),
      End: onFollow,
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };
  return (
    <div data-slot='surface-scrubber' className='absolute inset-y-0 right-0 flex w-9 flex-col items-center gap-2 py-3'>
      <div
        ref={track}
        role='slider'
        tabIndex={0}
        aria-label='Scroll the Surface'
        aria-orientation='vertical'
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
        aria-valuetext={following ? 'Following the end' : `${Math.round(fraction * 100)}% down`}
        aria-disabled={!scrollable || undefined}
        className='relative w-full flex-1 touch-none outline-none aria-disabled:opacity-40'
        onKeyDown={onKeyDown}
        onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
          if (!scrollable) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          move(at(event.clientY));
        }}
        onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
          if (held !== undefined) move(at(event.clientY));
        }}
        onPointerUp={() => setHeld(undefined)}
        onPointerCancel={() => setHeld(undefined)}
      >
        <span aria-hidden='true' className='absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 rounded-full bg-muted' />
        <span aria-hidden='true' className='absolute left-1/2 h-10 w-1.5 -translate-x-1/2 rounded-full bg-foreground/60'
          style={{ top: `calc(${fraction} * (100% - 2.5rem))` }} />
      </div>
      {!following && scrollable && (
        <Button size='icon-sm' variant='secondary' aria-label='Latest' onClick={onFollow}>
          <HugeiconsIcon icon={ArrowDown02Icon} strokeWidth={2} />
        </Button>
      )}
    </div>
  );
}
