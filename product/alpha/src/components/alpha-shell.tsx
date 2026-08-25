import { useEffect, type CSSProperties } from 'react';
import type { AlphaController } from '@/app/alpha-controller';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { ConnectionPlaceholder } from './connection-placeholder';
import { ThreadSidebar } from './thread-sidebar';
import { WorkspacePlaceholder } from './workspace-placeholder';

export function AlphaShell({ controller }: { controller: AlphaController }) {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    const syncViewportFrame = () => {
      root.style.setProperty(
        '--alpha-viewport-height',
        `${viewport?.height ?? window.innerHeight}px`,
      );
      root.style.setProperty(
        '--alpha-viewport-top',
        `${viewport?.offsetTop ?? 0}px`,
      );
    };

    syncViewportFrame();
    viewport?.addEventListener('resize', syncViewportFrame);
    viewport?.addEventListener('scroll', syncViewportFrame);
    window.addEventListener('resize', syncViewportFrame);

    return () => {
      viewport?.removeEventListener('resize', syncViewportFrame);
      viewport?.removeEventListener('scroll', syncViewportFrame);
      window.removeEventListener('resize', syncViewportFrame);
      root.style.removeProperty('--alpha-viewport-height');
      root.style.removeProperty('--alpha-viewport-top');
    };
  }, []);

  useEffect(() => {
    if (controller.model.connection.status !== 'connected') return;

    const resetViewportOrigin = () => {
      const active = document.activeElement;
      const editing = active instanceof HTMLInputElement
        || active instanceof HTMLTextAreaElement
        || active?.getAttribute('contenteditable') === 'true';
      if (!editing) window.scrollTo(0, 0);
    };

    resetViewportOrigin();
    const frame = window.requestAnimationFrame(resetViewportOrigin);
    const keyboardTransition = window.setTimeout(resetViewportOrigin, 350);
    window.visualViewport?.addEventListener('resize', resetViewportOrigin);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(keyboardTransition);
      window.visualViewport?.removeEventListener('resize', resetViewportOrigin);
    };
  }, [controller.model.connection.status]);

  if (controller.model.connection.status !== 'connected') {
    return <ConnectionPlaceholder controller={controller} />;
  }

  return (
    <SidebarProvider
      className="fixed inset-x-0 top-[var(--alpha-viewport-top,0px)] h-[var(--alpha-viewport-height,100dvh)] min-h-0 overflow-hidden"
      style={{
        '--sidebar-width': '19rem',
        '--sidebar-width-mobile': '19rem',
        '--bottom-rail-height': '2rem',
      } as CSSProperties}
    >
      <ThreadSidebar controller={controller} />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <WorkspacePlaceholder controller={controller} />
      </SidebarInset>
    </SidebarProvider>
  );
}
