// The heading of a Project or a Host in the list of Sessions (WVE-231): its icon, its name and,
// at the end of the row before its + button, a chevron; a click collapses or opens it. One with
// nothing under it has no chevron and isn't a button. While it's collapsed, a dot says what's going on in what it hides.
import type { ReactNode } from 'react';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import { ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { ActivityIndicator } from '@/components/activity-indicator';
import { SidebarGroupLabel } from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

export type GroupFold = {
  open: boolean;
  onToggle(): void;
  /** What its Sessions are doing, shown while it hides them. */
  activity?: 'waiting' | 'running';
  unread?: boolean;
};

export function GroupHeading({ name, icon, iconClassName, fold, title, children }: {
  name: string;
  icon: IconSvgElement;
  iconClassName: string;
  /** None for a heading with nothing under it. */
  fold?: GroupFold;
  title?: string;
  /** After its name: how a Host is connected, when it isn't. */
  children?: ReactNode;
}) {
  return (
    <SidebarGroupLabel title={title}
      {...(fold ? { render: <button type='button' />, 'aria-expanded': fold.open, onClick: fold.onToggle } : {})}
      className='h-9 w-full cursor-default gap-2 pr-9 text-left text-sm font-medium text-sidebar-foreground [&>svg]:size-4.5'>
      <HugeiconsIcon icon={icon} strokeWidth={1.75} className={iconClassName} aria-hidden />
      <span className='min-w-0 truncate'>{name}</span>
      {children}
      {fold && !fold.open && <ActivityIndicator activity={fold.activity} unread={fold.unread} className='size-2 shrink-0' />}
      {fold && (
        <span aria-hidden='true' className='ml-auto grid size-4 shrink-0 place-items-center text-muted-foreground'>
          <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className={cn('size-3.5 transition-transform', fold.open && 'rotate-90')} />
        </span>
      )}
    </SidebarGroupLabel>
  );
}
