import type { CSSProperties } from 'react';
import type { AlphaController } from '@/app/alpha-controller';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { ConnectionPlaceholder } from './connection-placeholder';
import { ThreadSidebar } from './thread-sidebar';
import { WorkspacePlaceholder } from './workspace-placeholder';

export function AlphaShell({ controller }: { controller: AlphaController }) {
  if (controller.model.connection.status !== 'connected') {
    return <ConnectionPlaceholder controller={controller} />;
  }

  return (
    <SidebarProvider
      className="h-svh min-h-0 overflow-hidden"
      style={{
        '--sidebar-width': '19rem',
        '--sidebar-width-mobile': '19rem',
        '--bottom-rail-height': '2rem',
      } as CSSProperties}
    >
      <ThreadSidebar controller={controller} />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <WorkspacePlaceholder model={controller.model} />
      </SidebarInset>
    </SidebarProvider>
  );
}
