import { Suspense } from 'react';
import { TerminalPanel, type TerminalPanelTab, type TerminalPanelTabsChange, type TerminalPanelTarget } from './TerminalPanel';
import type { TerminalTransport } from '../../lib/terminal-types';

type TerminalPaneHostProps = {
  activeTabId?: string;
  canToggleMaximized: boolean;
  error?: string;
  focusRequest: number;
  isSyncing?: boolean;
  isEffectivelyMaximized: boolean;
  onActiveTabIdChange: (tabId: string) => void;
  onAddTab: () => void;
  onCloseTab: (tab: TerminalPanelTab) => void;
  onExit: (tab: TerminalPanelTab) => void;
  onHide: () => void;
  onMaximizeToggle: () => void;
  onRestoreMaximized: () => void;
  onSessionActiveChange: (isActive: boolean) => void;
  onTabsChange: (tabs: TerminalPanelTabsChange) => void;
  tabs: TerminalPanelTab[];
  target?: TerminalPanelTarget;
  transport?: TerminalTransport;
  variant: 'pane' | 'main';
};

export const TerminalPaneHost = ({
  activeTabId,
  canToggleMaximized,
  error,
  focusRequest,
  isSyncing,
  isEffectivelyMaximized,
  onActiveTabIdChange,
  onAddTab,
  onCloseTab,
  onExit,
  onHide,
  onMaximizeToggle,
  onRestoreMaximized,
  onSessionActiveChange,
  onTabsChange,
  tabs,
  target,
  transport,
  variant,
}: TerminalPaneHostProps) => target ? (
  <Suspense fallback={null}>
    <TerminalPanel
      activeTabId={activeTabId}
      error={error}
      focusRequest={focusRequest}
      isExpanded={variant === 'main' ? isEffectivelyMaximized : false}
      isSyncing={isSyncing}
      onActiveTabIdChange={onActiveTabIdChange}
      onAddTab={onAddTab}
      onCloseTab={onCloseTab}
      onExpandedChange={canToggleMaximized
        ? nextExpanded => {
            if (nextExpanded) onMaximizeToggle();
            else onRestoreMaximized();
          }
        : undefined}
      onExit={onExit}
      onSessionActiveChange={onSessionActiveChange}
      onTabsChange={onTabsChange}
      tabs={tabs}
      target={target}
      transport={transport}
      onHide={onHide}
      variant={variant}
    />
  </Suspense>
) : null;
