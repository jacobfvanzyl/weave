import { lazy, Suspense, type ReactNode } from 'react';
import type { EditorMode } from '../../lib/editor-types';
import type { EditorFollowRequest } from '../../stores/workspace-surface-store';
import { PaneContentHost, type PaneHostIdentity, type PaneHostLifecycle } from '../panes/PaneContentHost';
import type { UnifiedEditorTarget } from './UnifiedEditorPanel';

const UnifiedEditorPanel = lazy(() => import('./UnifiedEditorPanel').then(module => ({ default: module.UnifiedEditorPanel })));

type EditorPaneHostProps = {
  breadcrumb?: ReactNode;
  followRequest?: EditorFollowRequest;
  forceExplorerHoverOnly?: boolean;
  identity: PaneHostIdentity;
  isMaximized: boolean;
  lifecycle: PaneHostLifecycle;
  mode: EditorMode;
  target: UnifiedEditorTarget;
  terminalSlot?: ReactNode;
  onExpandedChange: (isExpanded: boolean) => void;
  proposalBackFilePath?: string;
  onBackToProposalPreview?: (path: string) => void;
};

export const EditorPaneHost = ({
  breadcrumb,
  followRequest,
  forceExplorerHoverOnly = false,
  identity,
  isMaximized,
  lifecycle,
  mode,
  target,
  terminalSlot,
  onExpandedChange,
  proposalBackFilePath,
  onBackToProposalPreview,
}: EditorPaneHostProps) => (
  <PaneContentHost
    className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    identity={identity}
    paneType="editor"
    data-maximized={isMaximized ? 'true' : 'false'}
  >
    <div className="min-h-0 flex-1 overflow-hidden">
      <Suspense fallback={null}>
        <UnifiedEditorPanel
          followRequest={followRequest}
          focusRequest={lifecycle.focusRequest}
          forceExplorerHoverOnly={forceExplorerHoverOnly}
          breadcrumb={breadcrumb}
          isExpanded={isMaximized}
          mode={mode}
          onExpandedChange={onExpandedChange}
          proposalBackFilePath={proposalBackFilePath}
          onBackToProposalPreview={onBackToProposalPreview}
          target={target}
          onHide={lifecycle.onClose}
        />
      </Suspense>
    </div>
    {terminalSlot}
  </PaneContentHost>
);
