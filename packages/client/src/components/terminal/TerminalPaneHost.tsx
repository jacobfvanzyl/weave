import { Suspense } from 'react';
import { TerminalPanel, type TerminalPanelTab, type TerminalPanelTabsChange, type TerminalPanelTarget } from './TerminalPanel';

type TerminalPaneHostProps = {
  activeTabId?: string;
  canToggleMaximized: boolean;
  focusRequest: number;
  isEffectivelyMaximized: boolean;
  onActiveTabIdChange: (tabId: string) => void;
  onCreateTab: (ordinal: number) => TerminalPanelTab;
  onHide: () => void;
  onMaximizeToggle: () => void;
  onRestoreMaximized: () => void;
  onSessionActiveChange: (isActive: boolean) => void;
  onTabsChange: (tabs: TerminalPanelTabsChange) => void;
  tabs: TerminalPanelTab[];
  target?: TerminalPanelTarget;
  variant: 'pane' | 'main';
};

export const TerminalPaneHost = ({
  activeTabId,
  canToggleMaximized,
  focusRequest,
  isEffectivelyMaximized,
  onActiveTabIdChange,
  onCreateTab,
  onHide,
  onMaximizeToggle,
  onRestoreMaximized,
  onSessionActiveChange,
  onTabsChange,
  tabs,
  target,
  variant,
}: TerminalPaneHostProps) => target ? (
  <Suspense fallback={null}>
    <TerminalPanel
      activeTabId={activeTabId}
      focusRequest={focusRequest}
      isExpanded={variant === 'main' ? isEffectivelyMaximized : false}
      onActiveTabIdChange={onActiveTabIdChange}
      onCreateTab={onCreateTab}
      onExpandedChange={canToggleMaximized
        ? nextExpanded => {
            if (nextExpanded) onMaximizeToggle();
            else onRestoreMaximized();
          }
        : undefined}
      onSessionActiveChange={onSessionActiveChange}
      onTabsChange={onTabsChange}
      tabs={tabs}
      target={target}
      onHide={onHide}
      variant={variant}
    />
  </Suspense>
) : null;
