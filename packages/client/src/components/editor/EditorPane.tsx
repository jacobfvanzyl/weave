import { lazy, Suspense, type ReactNode } from 'react';
import type { EditorMode } from '../../lib/editor-types';
import type { EditorFollowRequest } from '../../stores/workspace-surface-store';
import type { UnifiedEditorTarget } from './UnifiedEditorPanel';

const UnifiedEditorPanel = lazy(() => import('./UnifiedEditorPanel').then(module => ({ default: module.UnifiedEditorPanel })));

type EditorPaneProps = {
  breadcrumb?: ReactNode;
  followRequest?: EditorFollowRequest;
  focusRequest: number;
  isMaximized: boolean;
  mode: EditorMode;
  target: UnifiedEditorTarget;
  terminalSlot?: ReactNode;
  onClose: () => void;
  onExpandedChange: (isExpanded: boolean) => void;
  proposalBackFilePath?: string;
  onBackToProposalPreview?: (path: string) => void;
};

export const EditorPane = ({
  breadcrumb,
  followRequest,
  focusRequest,
  isMaximized,
  mode,
  target,
  terminalSlot,
  onClose,
  onExpandedChange,
  proposalBackFilePath,
  onBackToProposalPreview,
}: EditorPaneProps) => (
  <div
    key="editor"
    className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden"
    data-weave-main-pane="editor"
    data-maximized={isMaximized ? 'true' : 'false'}
  >
    <div className="min-h-0 flex-1 overflow-hidden">
      <Suspense fallback={null}>
        <UnifiedEditorPanel
          followRequest={followRequest}
          focusRequest={focusRequest}
          breadcrumb={breadcrumb}
          isExpanded={isMaximized}
          mode={mode}
          onExpandedChange={onExpandedChange}
          proposalBackFilePath={proposalBackFilePath}
          onBackToProposalPreview={onBackToProposalPreview}
          target={target}
          onHide={onClose}
        />
      </Suspense>
    </div>
    {terminalSlot}
  </div>
);
