import { Suspense, type ReactNode } from 'react';
import { TerminalPanel, type TerminalPanelTab, type TerminalPanelTabsChange, type TerminalPanelTarget } from './TerminalPanel';
import type { TerminalTransport } from '../../lib/terminal-types';
import type { TerminalPaneColumn } from '../../stores/workspace-surface-store';

type TerminalPaneHostProps = {
  activeTabId?: string;
  breadcrumb?: ReactNode;
  canToggleMaximized: boolean;
  error?: string;
  focusRequest: number;
  isSyncing?: boolean;
  isEffectivelyMaximized: boolean;
  layoutSyncKey?: string;
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
  terminalColumn?: TerminalPaneColumn;
  transport?: TerminalTransport;
  onTerminalColumnToggle?: () => void;
  variant: 'pane' | 'main';
};

export const TerminalPaneHost = ({
  activeTabId,
  breadcrumb,
  canToggleMaximized,
  error,
  focusRequest,
  isSyncing,
  isEffectivelyMaximized,
  layoutSyncKey,
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
  terminalColumn,
  transport,
  onTerminalColumnToggle,
  variant,
}: TerminalPaneHostProps) => target ? (
  <Suspense fallback={null}>
    <TerminalPanel
      activeTabId={activeTabId}
      breadcrumb={breadcrumb}
      error={error}
      focusRequest={focusRequest}
      isExpanded={variant === 'main' ? isEffectivelyMaximized : false}
      isSyncing={isSyncing}
      layoutSyncKey={layoutSyncKey}
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
      terminalColumn={terminalColumn}
      transport={transport}
      onTerminalColumnToggle={onTerminalColumnToggle}
      onHide={onHide}
      variant={variant}
    />
  </Suspense>
) : null;
