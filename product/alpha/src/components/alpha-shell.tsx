import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import type { GroupImperativeHandle, Layout } from 'react-resizable-panels';
import { type AlphaController, selectedThread } from '@/app/alpha-controller';
import {
  type AlphaDockPanelId,
  type AlphaMovableDockPanelId,
  useAlphaDockLayout,
} from '@/app/alpha-dock-layout';
import {
  alphaTerminalScopeKey,
  selectedTerminalScope,
} from '@/app/alpha-terminal-scope';
import {
  type AlphaPaneId,
  alphaPaneIds,
  alphaPaneMinimumWidths,
  alphaSidebarDefaultWidth,
  layoutChangesOnlyPanePair,
  layoutForPaneSet,
  paneSetKey,
  useAlphaPaneLayouts,
} from '@/app/alpha-pane-layout';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { SidebarInset, SidebarProvider, useSidebar } from '@/components/ui/sidebar';
import { ConnectionsDialog } from './connections-dialog';
import { ArchivedThreadsDialog } from './archived-threads-dialog';
import { BrowserPane } from './browser-pane';
import { DockRailActions } from './dock-rail-actions';
import { EditorPane } from './editor-pane';
import { GlobalBottomRail } from './global-bottom-rail';
import { ProjectPane } from './project-pane';
import { TerminalPane } from './terminal-pane';
import { ThreadSidebar } from './thread-sidebar';
import { WorkspacePlaceholder } from './workspace-placeholder';
import { cn } from '@/lib/utils';
import { isCapacitorPlatform } from '@/lib/platform';
import { useIsMobile } from '@/hooks/use-mobile';

type PaneLayouts = ReturnType<typeof useAlphaPaneLayouts>;

const paneHandleClassName =
  'bg-transparent before:absolute before:inset-x-0 before:inset-y-0 before:bg-border hover:before:bg-ring focus-visible:before:bg-ring';

function PaneRow({
  controller,
  paneLayouts,
  isMobile,
}: {
  controller: AlphaController;
  paneLayouts: PaneLayouts;
  isMobile: boolean;
}) {
  const { model, actions } = controller;
  const [showMobileEditor, setShowMobileEditor] = useState(false);
  const rowRef = useRef<GroupImperativeHandle>(null);
  const acceptedLayoutRef = useRef<Layout | undefined>(undefined);
  const activeResizePairRef = useRef<
    readonly [AlphaPaneId, AlphaPaneId] | undefined
  >(undefined);
  const acceptedRowKeyRef = useRef<string | undefined>(undefined);
  const openFiles = model.workspaceFiles?.openFiles ?? [];
  const hasActiveThread = Boolean(model.selectedThreadId);
  const editorOpen = hasActiveThread && openFiles.length > 0;

  useEffect(() => {
    const clearActiveResizePair = () => {
      activeResizePairRef.current = undefined;
    };
    window.addEventListener('pointerup', clearActiveResizePair);
    window.addEventListener('pointercancel', clearActiveResizePair);
    window.addEventListener('keyup', clearActiveResizePair);
    return () => {
      window.removeEventListener('pointerup', clearActiveResizePair);
      window.removeEventListener('pointercancel', clearActiveResizePair);
      window.removeEventListener('keyup', clearActiveResizePair);
    };
  }, []);

  if (isMobile) {
    return (
      <>
        <div className='flex min-h-0 min-w-0 flex-1'>
          <WorkspacePlaceholder
            controller={controller}
            className={cn(showMobileEditor && editorOpen && 'max-md:hidden')}
            showFooter={false}
          />
          {editorOpen && (
            <EditorPane
              files={openFiles}
              activeFilePath={model.workspaceFiles?.activeFilePath}
              busy={model.busy}
              className={cn(!showMobileEditor && 'max-md:hidden')}
              onActivateFile={actions.activateWorkspaceFile}
              onCloseFile={actions.closeWorkspaceFile}
              onReloadFile={() => void actions.reloadWorkspaceFile()}
              onReturnToThread={() => setShowMobileEditor(false)}
              showFooter={false}
            />
          )}
        </div>
      </>
    );
  }

  const visiblePaneIds: AlphaPaneId[] = [
    alphaPaneIds.thread,
    ...(editorOpen ? [alphaPaneIds.editor] : []),
  ];
  const rowKey = paneSetKey(visiblePaneIds);
  if (acceptedRowKeyRef.current !== rowKey) {
    acceptedRowKeyRef.current = rowKey;
    acceptedLayoutRef.current = undefined;
    activeResizePairRef.current = undefined;
  }
  const equalizeRow = () => {
    activeResizePairRef.current = undefined;
    const ratio = 100 / visiblePaneIds.length;
    const layout: Layout = Object.fromEntries(
      visiblePaneIds.map((paneId) => [paneId, ratio]),
    );
    rowRef.current?.setLayout(layout);
    paneLayouts.rememberRowLayout(visiblePaneIds, layout);
  };
  const activateResizePair = (before: AlphaPaneId, after: AlphaPaneId) => {
    activeResizePairRef.current = [before, after];
  };
  const restoreIfResizePropagated = (layout: Layout) => {
    const previous = acceptedLayoutRef.current;
    const activePair = activeResizePairRef.current;
    if (
      previous &&
      activePair &&
      !layoutChangesOnlyPanePair(previous, layout, activePair)
    ) {
      rowRef.current?.setLayout(previous);
      return true;
    }
    return false;
  };
  const handleLayoutChange = (layout: Layout) => {
    if (restoreIfResizePropagated(layout)) return;
    acceptedLayoutRef.current = layout;
  };
  const handleLayoutChanged = (layout: Layout) => {
    if (restoreIfResizePropagated(layout)) return;
    acceptedLayoutRef.current = layout;
    paneLayouts.rememberRowLayout(visiblePaneIds, layout);
  };

  return (
    <ResizablePanelGroup
      key={`${paneLayouts.snapshot.threadId ?? 'none'}:${rowKey}`}
      id='alpha-content-pane-row'
      groupRef={rowRef}
      orientation='horizontal'
      defaultLayout={layoutForPaneSet(paneLayouts.snapshot, visiblePaneIds)}
      onLayoutChange={handleLayoutChange}
      onLayoutChanged={handleLayoutChanged}
      className='min-h-0 min-w-0 flex-1'
      data-slot='alpha-content-pane-row'
    >
      <ResizablePanel
        id={alphaPaneIds.thread}
        minSize={alphaPaneMinimumWidths[alphaPaneIds.thread]}
        className='flex min-w-0 overflow-hidden'
      >
        <WorkspacePlaceholder
          controller={controller}
          showFooter={false}
        />
      </ResizablePanel>

      {editorOpen && (
        <>
          <ResizableHandle
            aria-label='Resize Thread and Editor Panes'
            className={paneHandleClassName}
            onKeyDownCapture={() => activateResizePair(alphaPaneIds.thread, alphaPaneIds.editor)}
            onPointerDownCapture={() => activateResizePair(alphaPaneIds.thread, alphaPaneIds.editor)}
            onDoubleClick={equalizeRow}
          />
          <ResizablePanel
            id={alphaPaneIds.editor}
            minSize={alphaPaneMinimumWidths[alphaPaneIds.editor]}
            className='flex min-w-0 overflow-hidden'
          >
            <EditorPane
              files={openFiles}
              activeFilePath={model.workspaceFiles?.activeFilePath}
              busy={model.busy}
              onActivateFile={actions.activateWorkspaceFile}
              onCloseFile={actions.closeWorkspaceFile}
              onReloadFile={() => void actions.reloadWorkspaceFile()}
              onReturnToThread={() => setShowMobileEditor(false)}
              showFooter={false}
            />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
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

function ConnectedBottomRail({
  controller,
  dockActions,
}: {
  controller: AlphaController;
  dockActions: ReactNode;
}) {
  const threads = useSidebar();
  return (
    <GlobalBottomRail
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
    data: '',
    dataEpoch: 0,
    dataOffset: 0,
    loading: false,
    error: 'Select a Thread to open its Workspace Terminals.',
  };
  const bottomOpen = hasActiveThread && dockLayout.snapshot.docks.bottom.open;
  const rightOpen = hasActiveThread && dockLayout.snapshot.docks.right.open;
  const terminalActive = hasActiveThread && dockLayout.isPanelActive('terminal');
  const browserActive = hasActiveThread && dockLayout.isPanelActive('browser');
  const terminalIsMaximized = terminalActive &&
    maximizedPanelKey === `terminal:${terminalScopeKey}`;
  const browserIsMaximized = browserActive && maximizedPanelKey === 'browser';
  const maximizedPanelId: AlphaMovableDockPanelId | undefined = terminalIsMaximized
    ? 'terminal'
    : browserIsMaximized
    ? 'browser'
    : undefined;
  const capacitorPlatform = isCapacitorPlatform(controller.model.platform);

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

  useEffect(() => {
    if (!browserActive && maximizedPanelKey === 'browser') {
      setMaximizedPanelKey(undefined);
    }
  }, [browserActive, maximizedPanelKey]);

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

  const browserPane = () => (
    <BrowserPane
      controlTarget={selectedThread(controller.model)
        ? {
          threadId: selectedThread(controller.model)!.threadId,
          title: selectedThread(controller.model)!.title,
          controller: selectedThread(controller.model)!.agentName,
        }
        : undefined}
      maximized={browserIsMaximized}
      onClose={() => {
        setMaximizedPanelKey(undefined);
        dockLayout.hideBrowserPanel();
        setMobilePanelId((current) => current === 'browser' ? null : current);
      }}
      onToggleMaximized={() => setMaximizedPanelKey((current) =>
        current === 'browser' ? undefined : 'browser'
      )}
    />
  );

  const projectPane = (forceVisible = false) => (
    <SidebarProvider
      open
      onOpenChange={() => undefined}
      cookieName={false}
      keyboardShortcut={false}
      className='h-full min-h-0 min-w-0 overflow-hidden'
      style={{
        '--sidebar-width': '100%',
        '--sidebar-width-icon': '2rem',
      } as CSSProperties}
    >
      <ProjectPane
        files={controller.model.workspaceFiles}
        hasActiveThread={hasActiveThread}
        reconnecting={Boolean(
          selectedThread(controller.model) &&
            controller.model.connections.some(
              ({ hostId, status }) =>
                hostId === selectedThread(controller.model)?.hostId &&
                status === 'reconnecting',
            ),
        )}
        capacitorPlatform={capacitorPlatform}
        busy={controller.model.busy}
        showFooter={false}
        forceVisible={forceVisible}
        onOpenDirectory={(path) => void controller.actions.openWorkspaceDirectory(path)}
        onOpenFile={(path) => void controller.actions.openWorkspaceFile(path)}
      />
    </SidebarProvider>
  );

  const dockPane = (panelId: AlphaDockPanelId | null, forceProject = false) =>
    panelId === 'terminal'
      ? terminalPane()
      : panelId === 'browser'
      ? browserPane()
      : projectPane(forceProject);
  const bottomPanel = dockPane(dockLayout.snapshot.docks.bottom.activePanelId);
  const rightPanel = dockPane(dockLayout.snapshot.docks.right.activePanelId);
  const mobileActivePanel = mobilePanelId && dockLayout.isPanelActive(mobilePanelId)
    ? mobilePanelId
    : rightOpen
    ? dockLayout.snapshot.docks.right.activePanelId
    : bottomOpen
    ? 'terminal'
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
        '--bottom-rail-height': '2rem',
      } as CSSProperties}
    >
      <div data-slot='alpha-dock-content' className='flex min-h-0 min-w-0 flex-1 overflow-hidden'>
        {maximizedPanelId
          ? (
            <ResponsiveShell
              controller={controller}
              paneLayouts={paneLayouts}
              bottomOpen={false}
              bottomSize={dockLayout.snapshot.rememberedSize.bottom}
              bottomPane={bottomPanel}
              maximizedPane={maximizedPanelId === 'terminal' ? terminalPane() : browserPane()}
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
      <ConnectedBottomRail
        controller={controller}
        dockActions={rail}
      />
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
      <ConnectedShell controller={controller} />
      <ArchivedThreadsDialog controller={controller} />
      <ConnectionsDialog controller={controller} />
    </>
  );
}
