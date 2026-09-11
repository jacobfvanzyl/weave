import { useDesktopTitlebar } from '@/app/use-desktop-titlebar';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { type AlphaController } from '@/app/alpha-controller';
import {
  type AlphaDockPanelId,
  useAlphaDockLayout,
} from '@/app/alpha-dock-layout';
import {
  alphaTerminalScopeKey,
  selectedTerminalScope,
} from '@/app/alpha-terminal-scope';
import {
  alphaPaneIds,
  alphaPaneMinimumWidths,
  alphaSidebarDefaultWidth,
  useAlphaPaneLayouts,
} from '@/app/alpha-pane-layout';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { SidebarInset, SidebarProvider, useSidebar } from '@/components/ui/sidebar';
import { ConnectionsDialog } from './connections-dialog';
import { ArchivedThreadsDialog } from './archived-threads-dialog';
import { DockRailActions } from './dock-rail-actions';
import { GlobalTopRail } from './global-top-rail';
import { TerminalFirstShell } from './terminal-first-shell';
import { TerminalPane } from './terminal-pane';
import { ThreadSidebar } from './thread-sidebar';
import { WorkspacePlaceholder } from './workspace-placeholder';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';

type PaneLayouts = ReturnType<typeof useAlphaPaneLayouts>;

const paneHandleClassName =
  'bg-transparent before:absolute before:inset-x-0 before:inset-y-0 before:bg-border hover:before:bg-ring focus-visible:before:bg-ring';

function PaneRow({ controller }: { controller: AlphaController; paneLayouts: PaneLayouts; isMobile: boolean }) {
  return <WorkspacePlaceholder controller={controller} showFooter={false} />;
}

function WorkspaceFrame({
  controller,
  paneLayouts,
  isMobile,
}: {
  controller: AlphaController;
  paneLayouts: PaneLayouts;
  isMobile: boolean;
}) {
  return (
    <PaneRow
      controller={controller}
      paneLayouts={paneLayouts}
      isMobile={isMobile}
    />
  );
}

function ResponsiveShell({
  controller,
  paneLayouts,
  bottomOpen,
  bottomSize,
  bottomPane,
  maximizedPane,
  onBottomSizeChange,
}: {
  controller: AlphaController;
  paneLayouts: PaneLayouts;
  bottomOpen: boolean;
  bottomSize: number;
  bottomPane: ReactNode;
  maximizedPane?: ReactNode;
  onBottomSizeChange(size: number): void;
}) {
  const threadSidebar = useSidebar();
  const maximizedContent = maximizedPane
    ? (
      <div
        data-slot='alpha-maximized-dock-pane'
        className='flex min-h-0 min-w-0 flex-1 overflow-hidden'
      >
        {maximizedPane}
      </div>
    )
    : undefined;

  if (threadSidebar.isMobile) {
    return (
      <>
        <ThreadSidebar controller={controller} showFooter={false} />
        <SidebarInset className='min-h-0 min-w-0 overflow-hidden'>
          {maximizedContent ?? (
            <WorkspaceFrame
              controller={controller}
              paneLayouts={paneLayouts}
              isMobile
            />
          )}
        </SidebarInset>
      </>
    );
  }

  const contentColumn = maximizedContent ?? (
    <ResizablePanelGroup
      id='alpha-bottom-dock-group'
      orientation='vertical'
      defaultLayout={{
        workspace: 100 - bottomSize,
        bottom: bottomSize,
      }}
      onLayoutChanged={(layout) => {
        if (bottomOpen && layout.bottom) onBottomSizeChange(layout.bottom);
      }}
      className='min-h-0 min-w-0 flex-1'
      data-slot='alpha-bottom-dock-group'
    >
      <ResizablePanel
        id='workspace'
        minSize='12rem'
        className='flex min-h-0 min-w-0'
      >
        <WorkspaceFrame
          controller={controller}
          paneLayouts={paneLayouts}
          isMobile={false}
        />
      </ResizablePanel>
      {bottomOpen && (
        <>
          <ResizableHandle aria-label='Resize Workspace and Bottom Dock' />
          <ResizablePanel
            id='bottom'
            minSize='8rem'
            className='flex min-h-0 min-w-0 overflow-hidden'
          >
            {bottomPane}
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );

  if (threadSidebar.state !== 'expanded') return contentColumn;

  return (
    <ResizablePanelGroup
      id='alpha-pane-row'
      orientation='horizontal'
      defaultLayout={paneLayouts.sidebarWidth !== undefined
        ? {
          threads: paneLayouts.sidebarWidth,
          workspace: 100 - paneLayouts.sidebarWidth,
        }
        : undefined}
      onLayoutChanged={(layout) => {
        if (!layout.threads || !layout.workspace) return;
        paneLayouts.rememberSidebarWidth(layout.threads);
      }}
      className='min-h-0 min-w-0 flex-1'
      data-slot='alpha-pane-row'
    >
      <ResizablePanel
        id={alphaPaneIds.threads}
        defaultSize={alphaSidebarDefaultWidth}
        minSize={alphaPaneMinimumWidths[alphaPaneIds.threads]}
        className='flex min-h-0 min-w-0 overflow-hidden'
      >
        <SidebarProvider
          open
          onOpenChange={paneLayouts.setThreadsVisible}
          cookieName={false}
          keyboardShortcut={false}
          className='h-full min-h-0 min-w-0 overflow-hidden'
        >
          <ThreadSidebar controller={controller} showFooter={false} />
        </SidebarProvider>
      </ResizablePanel>
      <ResizableHandle
        aria-label='Resize Threads and Workspace Panes'
        className={paneHandleClassName}
      />
      <ResizablePanel
        id='workspace'
        minSize='24rem'
        className='flex min-h-0 min-w-0 overflow-hidden'
      >
        {contentColumn}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function ConnectedTopRail({
  controller,
  dockActions,
}: {
  controller: AlphaController;
  dockActions: ReactNode;
}) {
  useDesktopTitlebar();
  const threads = useSidebar();
  return (
    <GlobalTopRail
      controller={controller}
      dockActions={dockActions}
      threadsVisible={threads.isMobile ? threads.openMobile : threads.state === 'expanded'}
      threadsToggleDisabled={!controller.model.selectedThreadId}
      onToggleThreads={threads.toggleSidebar}
    />
  );
}

function ConnectedShell({ controller }: { controller: AlphaController }) {
  const paneLayouts = useAlphaPaneLayouts(controller.model.selectedThreadId);
  const terminalScope = selectedTerminalScope(controller.model);
  const terminalScopeKey = terminalScope
    ? alphaTerminalScopeKey(terminalScope)
    : undefined;
  const dockLayout = useAlphaDockLayout(terminalScopeKey);
  const isMobile = useIsMobile();
  const [mobilePanelId, setMobilePanelId] = useState<AlphaDockPanelId | null>(
    null,
  );
  const [maximizedPanelKey, setMaximizedPanelKey] = useState<string>();
  const terminalVisibilityActionsRef = useRef({
    show: controller.actions.showTerminals,
    hide: controller.actions.hideTerminals,
  });
  terminalVisibilityActionsRef.current = {
    show: controller.actions.showTerminals,
    hide: controller.actions.hideTerminals,
  };
  const hasActiveThread = Boolean(controller.model.selectedThreadId);
  const terminalModel = controller.model.terminals ?? {
    supported: false,
    tabs: [],
    loading: false,
    error: 'Select a Thread to open its Workspace Terminals.',
  };
  const panelAvailable = (panelId: AlphaDockPanelId | null) =>
    panelId === 'terminal' && hasActiveThread;
  const bottomOpen = dockLayout.snapshot.docks.bottom.open &&
    panelAvailable(dockLayout.snapshot.docks.bottom.activePanelId);
  const rightOpen = dockLayout.snapshot.docks.right.open &&
    panelAvailable(dockLayout.snapshot.docks.right.activePanelId);
  const terminalActive = hasActiveThread && dockLayout.isPanelActive('terminal');
  const terminalIsMaximized = terminalActive &&
    maximizedPanelKey === `terminal:${terminalScopeKey}`;
  const maximizedPanelId = terminalIsMaximized ? 'terminal' : undefined;

  useEffect(() => {
    if (terminalActive) void terminalVisibilityActionsRef.current.show?.();
    else void terminalVisibilityActionsRef.current.hide?.();
  }, [controller.model.selectedThreadId, terminalActive]);

  useEffect(() => {
    if (
      !terminalActive &&
      terminalScopeKey &&
      maximizedPanelKey === `terminal:${terminalScopeKey}`
    ) {
      setMaximizedPanelKey(undefined);
    }
  }, [
    maximizedPanelKey,
    terminalActive,
    terminalScopeKey,
  ]);

  const toggleDockPanel = (panelId: AlphaDockPanelId) => {
    const panelWasActive = dockLayout.isPanelActive(panelId);
    dockLayout.togglePanel(panelId);
    setMobilePanelId(panelWasActive ? null : panelId);
  };

  const rail = (
    <DockRailActions
      snapshot={dockLayout.snapshot}
      disabled={!hasActiveThread}
      onToggle={toggleDockPanel}
      onMovePanel={(panelId, position) => {
        dockLayout.movePanel(panelId, position);
        if (dockLayout.isPanelActive(panelId)) setMobilePanelId(panelId);
      }}
    />
  );

  const terminalPane = () => (
    <TerminalPane
      model={terminalModel}
      disabled={controller.model.busy}
      showFooter={false}
      maximized={terminalIsMaximized}
      onCreate={controller.actions.createTerminal}
      onSelect={controller.actions.selectTerminal}
      onClose={async (terminalId) => {
        const closingLastTab = terminalModel.tabs.length === 1;
        await controller.actions.closeTerminal?.(terminalId);
        if (!closingLastTab) return;
        setMaximizedPanelKey(undefined);
        dockLayout.hideTerminalPanel();
        setMobilePanelId((current) => current === 'terminal' ? null : current);
      }}
      onToggleMaximized={() => setMaximizedPanelKey((current) =>
        current === `terminal:${terminalScopeKey}`
          ? undefined
          : `terminal:${terminalScopeKey}`
      )}
      onRetryControl={controller.actions.retryTerminalControl}
      onInput={controller.actions.inputTerminal}
      onResize={controller.actions.resizeTerminal}
    />
  );

  const dockPane = (panelId: AlphaDockPanelId | null, _forceExecutionContext = false) => panelId === 'terminal' ? terminalPane() : null;
  const bottomPanel = dockPane(dockLayout.snapshot.docks.bottom.activePanelId);
  const rightPanel = dockPane(dockLayout.snapshot.docks.right.activePanelId);
  const mobileActivePanel = mobilePanelId && dockLayout.isPanelActive(mobilePanelId)
    ? mobilePanelId
    : rightOpen
    ? dockLayout.snapshot.docks.right.activePanelId
    : bottomOpen
    ? dockLayout.snapshot.docks.bottom.activePanelId
    : null;

  return (
    <SidebarProvider
      open={!hasActiveThread || paneLayouts.snapshot.visible.threads}
      onOpenChange={(visible) => {
        if (hasActiveThread) paneLayouts.setThreadsVisible(visible);
      }}
      className={cn(
        'fixed inset-x-0 top-[var(--alpha-viewport-top,0px)] h-[var(--alpha-viewport-height,100dvh)] min-h-0 flex-col overflow-hidden',
        controller.model.platform === 'ios' && 'pt-[env(safe-area-inset-top)]',
      )}
      style={{
        '--sidebar-width': alphaSidebarDefaultWidth,
        '--sidebar-width-mobile': alphaSidebarDefaultWidth,
      } as CSSProperties}
    >
      <ConnectedTopRail
        controller={controller}
        dockActions={rail}
      />
      <div data-slot='alpha-dock-content' className='flex min-h-0 min-w-0 flex-1 overflow-hidden'>
        {maximizedPanelId
          ? (
            <ResponsiveShell
              controller={controller}
              paneLayouts={paneLayouts}
              bottomOpen={false}
              bottomSize={dockLayout.snapshot.rememberedSize.bottom}
              bottomPane={bottomPanel}
              maximizedPane={terminalPane()}
              onBottomSizeChange={(size) => dockLayout.rememberSize('bottom', size)}
            />
          )
          : isMobile
          ? (
            mobileActivePanel
              ? (
                <div
                  data-slot='alpha-mobile-dock-surface'
                  className='flex min-h-0 min-w-0 flex-1 overflow-hidden'
                >
                  {dockPane(mobileActivePanel, true)}
                </div>
              )
              : (
                <ResponsiveShell
                  controller={controller}
                  paneLayouts={paneLayouts}
                  bottomOpen={false}
                  bottomSize={dockLayout.snapshot.rememberedSize.bottom}
                  bottomPane={bottomPanel}
                  onBottomSizeChange={(size) => dockLayout.rememberSize('bottom', size)}
                />
              )
          )
          : (
            <ResizablePanelGroup
              id='alpha-right-dock-group'
              orientation='horizontal'
              defaultLayout={{
                workspace: 100 - dockLayout.snapshot.rememberedSize.right,
                right: dockLayout.snapshot.rememberedSize.right,
              }}
              onLayoutChanged={(layout) => {
                if (rightOpen && layout.right) {
                  dockLayout.rememberSize('right', layout.right);
                }
              }}
              className='min-h-0 min-w-0 flex-1'
              data-slot='alpha-right-dock-group'
            >
              <ResizablePanel
                id='workspace'
                minSize='24rem'
                className='flex min-h-0 min-w-0'
              >
                <ResponsiveShell
                  controller={controller}
                  paneLayouts={paneLayouts}
                  bottomOpen={bottomOpen}
                  bottomSize={dockLayout.snapshot.rememberedSize.bottom}
                  bottomPane={bottomPanel}
                  onBottomSizeChange={(size) => dockLayout.rememberSize('bottom', size)}
                />
              </ResizablePanel>
              {rightOpen && (
                <>
                  <ResizableHandle
                    aria-label='Resize Workspace and Right Dock'
                    className={paneHandleClassName}
                  />
                  <ResizablePanel
                    id='right'
                    minSize='14rem'
                    className='flex min-h-0 min-w-0 overflow-hidden'
                  >
                    {rightPanel}
                  </ResizablePanel>
                </>
              )}
            </ResizablePanelGroup>
          )}
      </div>

    </SidebarProvider>
  );
}

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
      const editing = active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active?.getAttribute('contenteditable') === 'true';
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

  if (!controller.model.connectionsLoaded) return null;
  if (!controller.model.connections.length) {
    return <ConnectionsDialog controller={controller} />;
  }
  return (
    <>
      {controller.model.workspaceCompositions ? <TerminalFirstShell controller={controller} /> : <ConnectedShell controller={controller} />}
      <ArchivedThreadsDialog controller={controller} />
      <ConnectionsDialog controller={controller} />
    </>
  );
}
