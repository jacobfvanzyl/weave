import type { ReactNode } from 'react';
import { AppTopBar } from '../app-shell/AppTopBar';
import { MainPaneLayout } from './MainPaneLayout';

type WorkspaceMainContentProps = {
  centerContent?: ReactNode;
  emptyState?: ReactNode;
  isEmpty: boolean;
  isSidebarAutoHidden: boolean;
  isSidebarOpen: boolean;
  isSidebarPinnedOpen: boolean;
  leftActions?: ReactNode;
  panes: ReactNode;
  projectName?: string;
  rightActions?: ReactNode;
  showSidebarPreview: boolean;
  tabStrip?: ReactNode;
  threadTitle?: string;
  workspaceName?: string;
};

export const WorkspaceMainContent = ({
  centerContent,
  emptyState,
  isEmpty,
  isSidebarAutoHidden,
  isSidebarOpen,
  isSidebarPinnedOpen,
  leftActions,
  panes,
  projectName,
  rightActions,
  showSidebarPreview,
  tabStrip,
  threadTitle,
  workspaceName,
}: WorkspaceMainContentProps) => (
  <main
    className="flex min-w-0 flex-1 flex-col"
    data-sidebar-open={isSidebarOpen ? 'true' : 'false'}
    data-sidebar-pinned-open={isSidebarPinnedOpen ? 'true' : 'false'}
    data-sidebar-auto-hidden={isSidebarAutoHidden ? 'true' : 'false'}
    data-sidebar-preview-open={showSidebarPreview ? 'true' : 'false'}
  >
    <AppTopBar
      centerContent={centerContent}
      leftActions={leftActions}
      projectName={projectName}
      workspaceName={workspaceName}
      threadTitle={threadTitle}
      rightActions={rightActions}
    />
    {tabStrip}
    <MainPaneLayout isEmpty={isEmpty} emptyState={emptyState}>
      {panes}
    </MainPaneLayout>
  </main>
);
