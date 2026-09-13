import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { isElectronDesktop } from '@/lib/platform';
import { usePaneFocusAdapter } from '@/app/pane-focus';
import { nativeSoftwareKeyboard } from '@/terminal/native-terminal';

// All content types share rail geometry, native titlebar hit regions and focus
// paint. Content renderers own only their body and type-specific commands.
export function PaneFrame({ title, actions, focused, children }: { title: ReactNode; actions?: ReactNode; focused: boolean; children: ReactNode }) {
  const { owner, id } = usePaneFocusAdapter();
  return <>
    <header data-slot='pane-top-rail' data-hover-actions={isElectronDesktop() || undefined} onClick={() => { if (id) { if (nativeSoftwareKeyboard) owner?.browse(id); else owner?.request(id); } }} className='relative flex h-[var(--rail-height)] shrink-0 items-center gap-1 border-b bg-title-bar px-2'>
      <div aria-hidden='true' className='pointer-events-none absolute inset-0 z-10 bg-title-bar' style={{ opacity: focused ? 0 : 0.4 }} />
      <div className='min-w-0 flex-1 truncate text-xs'>{title}</div>
      {actions}
    </header>
    <div data-slot='pane-focus-border' className={cn('flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border', focused ? 'border-terminal-focus' : 'border-transparent')}>
      {children}
    </div>
  </>;
}
