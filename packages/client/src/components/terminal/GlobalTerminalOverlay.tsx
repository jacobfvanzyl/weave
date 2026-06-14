import { lazy, Suspense } from 'react';
import type { TerminalPanelTab, TerminalPanelTabsChange } from './TerminalPanel';

const TerminalPanel = lazy(() => import('./TerminalPanel').then(module => ({ default: module.TerminalPanel })));

type GlobalTerminalTarget = {
  kind: 'general';
  terminalId: string;
  title: string;
  portalId?: string;
  rootId?: string;
};

type GlobalTerminalOverlayProps = {
  activeTabId?: string;
  focusRequest: number;
  isOpen: boolean;
  onActiveTabIdChange: (tabId: string) => void;
  onCreateTab: (ordinal: number) => TerminalPanelTab;
  onHide: () => void;
  onSessionActiveChange: (isActive: boolean) => void;
  onTabsChange: (tabs: TerminalPanelTabsChange) => void;
  tabs: TerminalPanelTab[];
  target?: GlobalTerminalTarget;
};

export const GlobalTerminalOverlay = ({
  activeTabId,
  focusRequest,
  isOpen,
  onActiveTabIdChange,
  onCreateTab,
  onHide,
  onSessionActiveChange,
  onTabsChange,
  tabs,
  target,
}: GlobalTerminalOverlayProps) => isOpen && target ? (
  <div
    className="pointer-events-none fixed inset-0 z-50 bg-background/20 backdrop-blur-sm"
    data-weave-general-terminal-overlay
  >
    <div className="pointer-events-auto absolute inset-0 min-h-0 min-w-0">
      <Suspense fallback={null}>
        <TerminalPanel
          activeTabId={activeTabId}
          focusRequest={focusRequest}
          isExpanded={false}
          onActiveTabIdChange={onActiveTabIdChange}
          onCreateTab={onCreateTab}
          onSessionActiveChange={onSessionActiveChange}
          onTabsChange={onTabsChange}
          tabs={tabs}
          target={target}
          onHide={onHide}
          variant="overlay"
        />
      </Suspense>
    </div>
  </div>
) : null;
