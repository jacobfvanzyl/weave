import { lazy, Suspense } from 'react';
import type { TerminalPanelTab, TerminalPanelTabsChange } from './TerminalPanel';
import type { TerminalTransport } from '../../lib/terminal-types';

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
  error?: string;
  focusRequest: number;
  isOpen: boolean;
  isSyncing?: boolean;
  onActiveTabIdChange: (tabId: string) => void;
  onAddTab: () => void;
  onCloseTab: (tab: TerminalPanelTab) => void;
  onExit: (tab: TerminalPanelTab) => void;
  onHide: () => void;
  onSessionActiveChange: (isActive: boolean) => void;
  onTabsChange: (tabs: TerminalPanelTabsChange) => void;
  tabs: TerminalPanelTab[];
  target?: GlobalTerminalTarget;
  transport?: TerminalTransport;
};

export const GlobalTerminalOverlay = ({
  activeTabId,
  error,
  focusRequest,
  isOpen,
  isSyncing,
  onActiveTabIdChange,
  onAddTab,
  onCloseTab,
  onExit,
  onHide,
  onSessionActiveChange,
  onTabsChange,
  tabs,
  target,
  transport,
}: GlobalTerminalOverlayProps) => isOpen && target ? (
  <div
    className="pointer-events-none fixed inset-0 z-50 bg-background/20 backdrop-blur-sm"
    data-weave-general-terminal-overlay
  >
    <div className="pointer-events-auto absolute inset-0 min-h-0 min-w-0">
      <Suspense fallback={null}>
        <TerminalPanel
          activeTabId={activeTabId}
          error={error}
          focusRequest={focusRequest}
          isExpanded={false}
          isSyncing={isSyncing}
          onActiveTabIdChange={onActiveTabIdChange}
          onAddTab={onAddTab}
          onCloseTab={onCloseTab}
          onExit={onExit}
          onSessionActiveChange={onSessionActiveChange}
          onTabsChange={onTabsChange}
          tabs={tabs}
          target={target}
          transport={transport}
          onHide={onHide}
          variant="overlay"
        />
      </Suspense>
    </div>
  </div>
) : null;
