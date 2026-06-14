import { useMemo } from 'react';
import type { ShortcutCommand } from '../../lib/shortcuts';
import type { MainPane } from '../../stores/workspace-surface-store';

type UseAppShortcutsInput = {
  createThreadFromShortcut: () => void;
  focusChat: () => void;
  focusSidebar: () => void;
  focusTerminal: () => void;
  handleChatPaneToggle: () => void;
  handleEditorPaneToggle: () => void;
  handleGeneralTerminalToggle: () => void;
  handleMainPaneMaximizeToggle: (pane: MainPane) => void;
  handleTerminalPaneToggle: () => void;
  hasChatPaneTarget: boolean;
  hasEditorTarget: boolean;
  hasGeneralTerminalTarget: boolean;
  hasTerminalTarget: boolean;
  isSidebarOpen: boolean;
  setShowPlanPanel: (showPlanPanel: boolean) => void;
  showPlanPanel: boolean;
  showSidebarPreview: boolean;
  toggleSidebar: () => void;
};

export const useAppShortcuts = ({
  createThreadFromShortcut,
  focusChat,
  focusSidebar,
  focusTerminal,
  handleChatPaneToggle,
  handleEditorPaneToggle,
  handleGeneralTerminalToggle,
  handleMainPaneMaximizeToggle,
  handleTerminalPaneToggle,
  hasChatPaneTarget,
  hasEditorTarget,
  hasGeneralTerminalTarget,
  hasTerminalTarget,
  isSidebarOpen,
  setShowPlanPanel,
  showPlanPanel,
  showSidebarPreview,
  toggleSidebar,
}: UseAppShortcutsInput) => useMemo<ShortcutCommand[]>(() => [
  {
    id: 'shortcuts.open',
    label: 'Open shortcuts',
    surface: 'app',
    run: () => undefined,
  },
  {
    id: 'sidebar.toggle',
    label: 'Toggle sidebar',
    surface: 'sidebar',
    run: () => {
      const shouldFocusAfterOpen = !isSidebarOpen && !showSidebarPreview;
      toggleSidebar();
      if (shouldFocusAfterOpen) focusSidebar();
    },
  },
  {
    id: 'chat.focus',
    label: 'Focus chat',
    surface: 'chat',
    isEnabled: () => hasChatPaneTarget,
    run: focusChat,
  },
  {
    id: 'chat.toggle',
    label: 'Toggle chat pane',
    surface: 'chat',
    isEnabled: () => hasChatPaneTarget,
    run: handleChatPaneToggle,
  },
  {
    id: 'thread.new',
    label: 'New thread',
    surface: 'chat',
    run: createThreadFromShortcut,
  },
  {
    id: 'plan.toggle',
    label: 'Toggle plan',
    surface: 'plan',
    run: () => setShowPlanPanel(!showPlanPanel),
  },
  {
    id: 'terminal.globalToggle',
    label: 'Toggle global terminal',
    surface: 'terminal',
    isEnabled: () => hasGeneralTerminalTarget,
    run: handleGeneralTerminalToggle,
  },
  {
    id: 'terminal.toggle',
    label: 'Toggle terminal pane',
    surface: 'terminal',
    isEnabled: () => hasTerminalTarget,
    run: handleTerminalPaneToggle,
  },
  {
    id: 'terminal.expandToggle',
    label: 'Expand terminal pane',
    surface: 'terminal',
    isEnabled: () => hasTerminalTarget,
    run: () => {
      handleMainPaneMaximizeToggle('terminal');
      window.requestAnimationFrame(focusTerminal);
    },
  },
  {
    id: 'editor.toggle',
    label: 'Toggle editor pane',
    surface: 'editor',
    isEnabled: () => hasEditorTarget,
    run: handleEditorPaneToggle,
  },
  {
    id: 'editor.expandToggle',
    label: 'Expand editor pane',
    surface: 'editor',
    isEnabled: () => hasEditorTarget,
    run: () => {
      handleMainPaneMaximizeToggle('editor');
    },
  },
], [
  createThreadFromShortcut,
  focusChat,
  focusSidebar,
  focusTerminal,
  handleChatPaneToggle,
  handleEditorPaneToggle,
  handleGeneralTerminalToggle,
  handleMainPaneMaximizeToggle,
  handleTerminalPaneToggle,
  hasChatPaneTarget,
  hasEditorTarget,
  hasGeneralTerminalTarget,
  hasTerminalTarget,
  isSidebarOpen,
  setShowPlanPanel,
  showPlanPanel,
  showSidebarPreview,
  toggleSidebar,
]);
