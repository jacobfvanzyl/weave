import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { GroupImperativeHandle, Layout } from 'react-resizable-panels';
import type { AlphaController } from '@/app/alpha-controller';
import {
  alphaPaneIds,
  alphaPaneMinimumWidths,
  layoutChangesOnlyPanePair,
  layoutForPaneSet,
  paneSetKey,
  useAlphaPaneLayouts,
  type AlphaPaneId,
} from '@/app/alpha-pane-layout';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { SidebarInset, SidebarProvider, useSidebar } from '@/components/ui/sidebar';
import { ConnectionPlaceholder } from './connection-placeholder';
import { EditorPane } from './editor-pane';
import { ProjectPane } from './project-pane';
import { ThreadSidebar } from './thread-sidebar';
import { WorkspacePlaceholder } from './workspace-placeholder';
import { cn } from '@/lib/utils';

type PaneLayouts = ReturnType<typeof useAlphaPaneLayouts>;

const paneHandleClassName =
  'bg-transparent before:absolute before:inset-x-0 before:top-0 before:bottom-[var(--bottom-rail-height)] before:bg-border hover:before:bg-ring focus-visible:before:bg-ring';

function PaneRow({
  controller,
  onToggleThreads,
  threadSidebarVisible,
  onThreadSidebarVisibleChange,
  paneLayouts,
}: {
  controller: AlphaController;
  onToggleThreads(): void;
  threadSidebarVisible: boolean;
  onThreadSidebarVisibleChange(visible: boolean): void;
  paneLayouts: PaneLayouts;
}) {
  const { isMobile, openMobile, state: projectState } = useSidebar();
  const { model, actions } = controller;
  const [showMobileEditor, setShowMobileEditor] = useState(false);
  const rowRef = useRef<GroupImperativeHandle>(null);
  const acceptedLayoutRef = useRef<Layout | undefined>(undefined);
  const activeResizePairRef = useRef<
    readonly [AlphaPaneId, AlphaPaneId] | undefined
  >(undefined);
  const acceptedRowKeyRef = useRef<string | undefined>(undefined);
  const openFiles = model.workspaceFiles?.openFiles ?? [];
  const editorOpen = openFiles.length > 0;
  const projectVisible = isMobile ? openMobile : projectState === 'expanded';

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

  const projectPane = (
    <ProjectPane
      files={model.workspaceFiles}
      hasActiveThread={Boolean(model.selectedThreadId)}
      busy={model.busy}
      onOpenDirectory={(path) => void actions.openWorkspaceDirectory(path)}
      onOpenFile={(path) => {
        setShowMobileEditor(true);
        void actions.openWorkspaceFile(path);
      }}
    />
  );

  if (isMobile) {
    return (
      <>
        <div className='flex min-h-0 min-w-0 flex-1'>
          <WorkspacePlaceholder
            controller={controller}
            onToggleThreads={onToggleThreads}
            className={cn(showMobileEditor && editorOpen && 'max-md:hidden')}
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
            />
          )}
        </div>
        {projectPane}
      </>
    );
  }

  const visiblePaneIds: AlphaPaneId[] = [
    ...(threadSidebarVisible ? [alphaPaneIds.threads] : []),
    alphaPaneIds.thread,
    ...(editorOpen ? [alphaPaneIds.editor] : []),
    ...(projectVisible ? [alphaPaneIds.project] : []),
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
    if (previous && activePair && !layoutChangesOnlyPanePair(previous, layout, activePair)) {
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
            onKeyDownCapture={() =>
              activateResizePair(alphaPaneIds.threads, alphaPaneIds.thread)}
            onPointerDownCapture={() =>
              activateResizePair(alphaPaneIds.threads, alphaPaneIds.thread)}
            onDoubleClick={equalizeRow}
          />
        </>
      )}

      <ResizablePanel
        id={alphaPaneIds.thread}
        minSize={alphaPaneMinimumWidths[alphaPaneIds.thread]}
        className='flex min-w-0 overflow-hidden'
      >
        <WorkspacePlaceholder controller={controller} onToggleThreads={onToggleThreads} />
      </ResizablePanel>

      {editorOpen && (
        <>
          <ResizableHandle
            aria-label='Resize Thread and Editor Panes'
            className={paneHandleClassName}
            onKeyDownCapture={() =>
              activateResizePair(alphaPaneIds.thread, alphaPaneIds.editor)}
            onPointerDownCapture={() =>
              activateResizePair(alphaPaneIds.thread, alphaPaneIds.editor)}
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
            />
          </ResizablePanel>
        </>
      )}

      {projectVisible && (
        <>
          <ResizableHandle
            aria-label={`Resize ${editorOpen ? 'Editor' : 'Thread'} and Project Panes`}
            className={paneHandleClassName}
            onKeyDownCapture={() => activateResizePair(
              editorOpen ? alphaPaneIds.editor : alphaPaneIds.thread,
              alphaPaneIds.project,
            )}
            onPointerDownCapture={() => activateResizePair(
              editorOpen ? alphaPaneIds.editor : alphaPaneIds.thread,
              alphaPaneIds.project,
            )}
            onDoubleClick={equalizeRow}
          />
          <ResizablePanel
            id={alphaPaneIds.project}
            defaultSize='22rem'
            minSize={alphaPaneMinimumWidths[alphaPaneIds.project]}
            className='flex min-w-0 overflow-hidden'
          >
            {projectPane}
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
}: {
  controller: AlphaController;
  onToggleThreads(): void;
  threadSidebarVisible: boolean;
  onThreadSidebarVisibleChange(visible: boolean): void;
  paneLayouts: PaneLayouts;
}) {
  return (
    <SidebarProvider
      open={paneLayouts.snapshot.visible.project}
      onOpenChange={paneLayouts.setProjectVisible}
      cookieName='project_pane_state'
      keyboardShortcut={false}
      className='min-h-0 min-w-0 flex-1 overflow-hidden'
      style={{
        '--sidebar-width': '22rem',
        '--sidebar-width-icon': '2rem',
      } as CSSProperties}
    >
      <PaneRow
        controller={controller}
        onToggleThreads={onToggleThreads}
        threadSidebarVisible={threadSidebarVisible}
        onThreadSidebarVisibleChange={onThreadSidebarVisibleChange}
        paneLayouts={paneLayouts}
      />
    </SidebarProvider>
  );
}

function ResponsiveShell({
  controller,
  paneLayouts,
}: {
  controller: AlphaController;
  paneLayouts: PaneLayouts;
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
    />
  );
}

function ConnectedShell({ controller }: { controller: AlphaController }) {
  const paneLayouts = useAlphaPaneLayouts(controller.model.selectedThreadId);

  return (
    <SidebarProvider
      open={paneLayouts.snapshot.visible.threads}
      onOpenChange={paneLayouts.setThreadsVisible}
      className='fixed inset-x-0 top-[var(--alpha-viewport-top,0px)] h-[var(--alpha-viewport-height,100dvh)] min-h-0 overflow-hidden'
      style={{
        '--sidebar-width': '19rem',
        '--sidebar-width-mobile': '19rem',
        '--bottom-rail-height': '2rem',
      } as CSSProperties}
    >
      <ResponsiveShell controller={controller} paneLayouts={paneLayouts} />
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

  return <ConnectedShell controller={controller} />;
}
