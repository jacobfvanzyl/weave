import { cn } from '@/lib/utils';
import { Skeleton } from './ui/skeleton';

export function TerminalPaneSkeleton({ framed = false }: { framed?: boolean }) {
  return <div role='status' aria-label='Connecting terminal' className='flex min-h-0 flex-1 flex-col overflow-hidden' data-slot='terminal-pane-skeleton'>
    <div aria-hidden='true' className={cn('flex shrink-0 items-center border-b bg-title-bar px-2', framed ? 'h-[calc(var(--rail-height)-1px)]' : 'h-[var(--rail-height)]')}>
      <Skeleton className='h-2.5 w-28 max-w-full motion-reduce:animate-none' />
    </div>
    <div aria-hidden='true' className='flex max-w-sm flex-col gap-3 p-4'>
      <Skeleton className='h-2 w-20 max-w-full motion-reduce:animate-none' />
      <Skeleton className='h-2 w-3/4 motion-reduce:animate-none' />
      <Skeleton className='h-2 w-1/2 motion-reduce:animate-none' />
    </div>
  </div>;
}
