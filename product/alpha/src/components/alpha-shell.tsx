import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import type { GroupImperativeHandle, Layout } from 'react-resizable-panels';
import { type AlphaController, selectedThread } from '@/app/alpha-controller';
import { type AlphaDockPanelId, useAlphaDockLayout } from '@/app/alpha-dock-layout';
import {
  type AlphaPaneId,
  alphaPaneIds,
  alphaPaneMinimumWidths,
  layoutChangesOnlyPanePair,
  layoutForPaneSet,
  paneSetKey,
  useAlphaPaneLayouts,
} from '@/app/alpha-pane-layout';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { SidebarInset, SidebarProvider, useSidebar } from '@/components/ui/sidebar';
import { ConnectionsDialog } from './connections-dialog';
import { ArchivedThreadsDialog } from './archived-threads-dialog';
import { DockRailActions } from './dock-rail-actions';
import { EditorPane } from './editor-pane';
import { ProjectPane } from './project-pane';
import { TerminalPane } from './terminal-pane';
import { ThreadSidebar } from './thread-sidebar';
import { WorkspacePlaceholder } from './workspace-placeholder';
import { cn } from '@/lib/utils';
import { isCapacitorPlatform } from '@/lib/platform';
import { useIsMobile } from '@/hooks/use-mobile';

type PaneLayouts = ReturnType<typeof useAlphaPaneLayouts>;

const paneHandleClassName =
  'bg-transparent before:absolute before:inset-x-0 before:top-0 before:bottom-[var(--bottom-rail-height)] before:bg-border hover:before:bg-ring focus-visible:before:bg-ring';

function PaneRow({
  controller,
  onToggleThreads,
  threadSidebarVisible,
  onThreadSidebarVisibleChange,
  paneLayouts,
  isMobile,
  footerActions,
}: {
  controller: AlphaController;
  onToggleThreads(): void;
  threadSidebarVisible: boolean;
  onThreadSidebarVisibleChange(visible: boolean): void;
  paneLayouts: PaneLayouts;
  isMobile: boolean;
  footerActions?: ReactNode;
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
  const activeThread = selectedThread(model);
  const reconnecting = Boolean(
    activeThread &&
      model.connections.some(
        ({ hostId, status }) => hostId === activeThread.hostId && status === 'reconnecting',
      ),
  );
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
            onToggleThreads={onToggleThreads}
            className={cn(showMobileEditor && editorOpen && 'max-md:hidden')}
            footerActions={!editorOpen || !showMobileEditor ? footerActions : undefined}
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
              footerActions={showMobileEditor ? footerActions : undefined}
            />
          )}
        </div>
      </>
    );
  }

  const visiblePaneIds: AlphaPaneId[] = [
    ...(threadSidebarVisible ? [alphaPaneIds.threads] : []),
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
      id='alpha-pane-row'
      groupRef={rowRef}
      orientation='horizontal'
      defaultLayout={layoutForPaneSet(paneLayouts.snapshot, visiblePaneIds)}
      onLayoutChange={handleLayoutChange}
      onLayoutChanged={handleLayoutChanged}
      className='min-h-0 min-w-0 flex-1'
      data-slot='alpha-pane-row'
    >
      {threadSidebarVisible && (
        <>
          <ResizablePanel
            id={alphaPaneIds.threads}
            defaultSize='19rem'
            minSize={alphaPaneMinimumWidths[alphaPaneIds.threads]}
            className='flex min-w-0 overflow-hidden'
          >
            <SidebarProvider
              open={threadSidebarVisible}
              onOpenChange={onThreadSidebarVisibleChange}
              cookieName={false}
              keyboardShortcut={false}
              className='h-full min-h-0 min-w-0 overflow-hidden'
            >
              <ThreadSidebar controller={controller} />
            </SidebarProvider>
          </ResizablePanel>
          <ResizableHandle
            aria-label='Resize Threads and Thread Panes'
            className={paneHandleClassName}
            onKeyDownCapture={() => activateResizePair(alphaPaneIds.threads, alphaPaneIds.thread)}
            onPointerDownCapture={() => activateResizePair(alphaPaneIds.threads, alphaPaneIds.thread)}
            onDoubleClick={equalizeRow}
          />
        </>
      )}

      <ResizablePanel
        id={alphaPaneIds.thread}
        minSize={alphaPaneMinimumWidths[alphaPaneIds.thread]}
        className='flex min-w-0 overflow-hidden'
      >
        <WorkspacePlaceholder
          controller={controller}
          onToggleThreads={onToggleThreads}
          footerActions={!editorOpen ? footerActions : undefined}
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
              footerActions={footerActions}
            />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}

function WorkspaceFrame({
  controller,
  onToggleThreads,
  threadSidebarVisible,
  onThreadSidebarVisibleChange,
  paneLayouts,
  isMobile,
  footerActions,
}: {
  controller: AlphaController;
  onToggleThreads(): void;
  threadSidebarVisible: boolean;
  onThreadSidebarVisibleChange(visible: boolean): void;
  paneLayouts: PaneLayouts;
  isMobile: boolean;
  footerActions?: ReactNode;
}) {
  return (
    <PaneRow
      controller={controller}
      onToggleThreads={onToggleThreads}
      threadSidebarVisible={threadSidebarVisible}
      onThreadSidebarVisibleChange={onThreadSidebarVisibleChange}
      paneLayouts={paneLayouts}
      isMobile={isMobile}
      footerActions={footerActions}
    />
  );
}

function ResponsiveShell({
  controller,
  paneLayouts,
  footerActions,
}: {
  controller: AlphaController;
  paneLayouts: PaneLayouts;
  footerActions?: ReactNode;
}) {
  const threadSidebar = useSidebar();

  if (threadSidebar.isMobile) {
    return (
      <>
        <ThreadSidebar controller={controller} />
        <SidebarInset className='min-h-0 min-w-0 overflow-hidden'>
          <WorkspaceFrame
            controller={controller}
            onToggleThreads={threadSidebar.toggleSidebar}
            threadSidebarVisible={paneLayouts.snapshot.visible.threads}
            onThreadSidebarVisibleChange={paneLayouts.setThreadsVisible}
            paneLayouts={paneLayouts}
            isMobile
            footerActions={footerActions}
          />
        </SidebarInset>
      </>
    );
  }

  return (
    <WorkspaceFrame
      controller={controller}
      onToggleThreads={threadSidebar.toggleSidebar}
      threadSidebarVisible={threadSidebar.state === 'expanded'}
      onThreadSidebarVisibleChange={paneLayouts.setThreadsVisible}
      paneLayouts={paneLayouts}
      isMobile={false}
      footerActions={footerActions}
    />
  );
}

function ConnectedShell({ controller }: { controller: AlphaController }) {
  const paneLayouts = useAlphaPaneLayouts(controller.model.selectedThreadId);
  const dockLayout = useAlphaDockLayout();
  const isMobile = useIsMobile();
  const [mobilePanelId, setMobilePanelId] = useState<AlphaDockPanelId | null>(
    null,
  );
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

  useEffect(() => {
    if (terminalActive) void terminalVisibilityActionsRef.current.show?.();
    else void terminalVisibilityActionsRef.current.hide?.();
  }, [controller.model.selectedThreadId, terminalActive]);

  const toggleDockPanel = (panelId: AlphaDockPanelId) => {
    const panelWasActive = dockLayout.isPanelActive(panelId);
    dockLayout.togglePanel(panelId);
    setMobilePanelId(panelWasActive ? null : panelId);
  };

  const rail = (
    <DockRailActions
      snapshot={dockLayout.snapshot}
      disabled={!hasActiveThread}
      capacitorInset={isCapacitorPlatform(controller.model.platform)}
      onToggle={toggleDockPanel}
      onMoveTerminal={(position) => {
        dockLayout.moveTerminal(position);
        if (dockLayout.isPanelActive('terminal')) setMobilePanelId('terminal');
      }}
    />
  );

  const terminalPane = (footerActions?: ReactNode) => (
    <TerminalPane
      model={terminalModel}
      disabled={controller.model.busy}
      footerActions={footerActions}
      onCreate={controller.actions.createTerminal}
      onSelect={controller.actions.selectTerminal}
      onClose={controller.actions.closeTerminal}
      onRetryControl={controller.actions.retryTerminalControl}
      onInput={controller.actions.inputTerminal}
      onResize={controller.actions.resizeTerminal}
    />
  );

  const projectPane = (footerActions?: ReactNode, forceVisible = false) => (
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
        capacitorPlatform={isCapacitorPlatform(controller.model.platform)}
        busy={controller.model.busy}
        footerActions={footerActions}
        forceVisible={forceVisible}
        onOpenDirectory={(path) => void controller.actions.openWorkspaceDirectory(path)}
        onOpenFile={(path) => void controller.actions.openWorkspaceFile(path)}
      />
    </SidebarProvider>
  );

  const rightPanel = dockLayout.snapshot.docks.right.activePanelId === 'terminal'
    ? terminalPane(rail)
    : projectPane(rail);
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
        'fixed inset-x-0 top-[var(--alpha-viewport-top,0px)] h-[var(--alpha-viewport-height,100dvh)] min-h-0 overflow-hidden',
        controller.model.platform === 'ios' && 'pt-[env(safe-area-inset-top)]',
      )}
      style={{
        '--sidebar-width': '19rem',
        '--sidebar-width-mobile': '19rem',
        '--bottom-rail-height': '2rem',
      } as CSSProperties}
    >
      {isMobile
        ? (
          mobileActivePanel
            ? (
              <div
                data-slot='alpha-mobile-dock-surface'
                className='flex min-h-0 min-w-0 flex-1 overflow-hidden'
              >
                {mobileActivePanel === 'terminal' ? terminalPane(rail) : projectPane(rail, true)}
              </div>
            )
            : (
              <ResponsiveShell
                controller={controller}
                paneLayouts={paneLayouts}
                footerActions={rail}
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
              <ResizablePanelGroup
                id='alpha-bottom-dock-group'
                orientation='vertical'
                defaultLayout={{
                  workspace: 100 - dockLayout.snapshot.rememberedSize.bottom,
                  bottom: dockLayout.snapshot.rememberedSize.bottom,
                }}
                onLayoutChanged={(layout) => {
                  if (bottomOpen && layout.bottom) {
                    dockLayout.rememberSize('bottom', layout.bottom);
                  }
                }}
                className='min-h-0 min-w-0 flex-1'
                data-slot='alpha-bottom-dock-group'
              >
                <ResizablePanel
                  id='workspace'
                  minSize='12rem'
                  className='flex min-h-0 min-w-0'
                >
                  <ResponsiveShell
                    controller={controller}
                    paneLayouts={paneLayouts}
                    footerActions={!bottomOpen && !rightOpen ? rail : undefined}
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
                      {terminalPane(!rightOpen ? rail : undefined)}
                    </ResizablePanel>
                  </>
                )}
              </ResizablePanelGroup>
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
