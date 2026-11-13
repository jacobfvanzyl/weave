import type { ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { type Folder01Icon, UnfoldMoreIcon } from '@hugeicons/core-free-icons';
import { cn } from '@/lib/utils';

// The fields the app's dialogs share.

/** A native select, which gives iOS its own picker. */
export function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-7 w-full min-w-0 rounded-md border border-input bg-input-background px-2 text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 md:text-xs/relaxed',
        className,
      )}
      {...props}
    />
  );
}

/** A field that shows a choice and opens its picker in place of the form. */
export function PickerField({ id, icon, iconClassName, title, onOpen, children }: {
  id: string;
  icon: typeof Folder01Icon;
  /** The icon's colour, as a Project's green; muted when none. */
  iconClassName?: string;
  title?: string;
  onOpen(): void;
  children: ReactNode;
}) {
  return (
    <button
      id={id}
      type='button'
      title={title}
      className='flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md border border-input bg-input-background px-2 text-left text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 md:text-xs/relaxed'
      onClick={onOpen}
    >
      <HugeiconsIcon icon={icon} strokeWidth={1.75} className={cn('size-3.5 shrink-0', iconClassName ?? 'text-muted-foreground')} aria-hidden />
      <span className='flex min-w-0 flex-1 items-baseline gap-1.5'>{children}</span>
      <HugeiconsIcon icon={UnfoldMoreIcon} strokeWidth={2} className='size-3.5 shrink-0 text-muted-foreground' aria-hidden />
    </button>
  );
}

/** The directory a path is in, for showing beside its name. */
export const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), 1));
