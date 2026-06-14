import { lazy, Suspense, type ReactNode } from 'react';
import type { EditorMode } from '../../lib/editor-types';
import type { EditorFollowRequest } from '../../stores/workspace-surface-store';
import type { UnifiedEditorTarget } from './UnifiedEditorPanel';

const UnifiedEditorPanel = lazy(() => import('./UnifiedEditorPanel').then(module => ({ default: module.UnifiedEditorPanel })));

type EditorPaneProps = {
  followRequest?: EditorFollowRequest;
  focusRequest: number;
  isMaximized: boolean;
  mode: EditorMode;
  target: UnifiedEditorTarget;
  terminalSlot?: ReactNode;
  onClose: () => void;
  onExpandedChange: (isExpanded: boolean) => void;
};

export const EditorPane = ({
  followRequest,
  focusRequest,
  isMaximized,
  mode,
  target,
  terminalSlot,
  onClose,
  onExpandedChange,
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
          isExpanded={isMaximized}
          mode={mode}
          onExpandedChange={onExpandedChange}
          target={target}
          onHide={onClose}
        />
      </Suspense>
    </div>
    {terminalSlot}
  </div>
);
