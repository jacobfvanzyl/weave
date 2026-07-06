import { useMemo } from 'react';
import type { ShortcutCommand, ShortcutContext, ShortcutSurface } from '../../lib/shortcuts';
import type { MainPane } from '../../stores/workspace-surface-store';

type StateAwarePaneShortcutInput = {
  focus: () => void;
  focusLabel: string;
  isOpen: boolean;
  surface: Extract<ShortcutSurface, 'chat' | 'editor' | 'terminal'>;
  toggle: () => void;
  toggleLabel: string;
};

export const shouldFocusOpenPaneFromShortcut = (
  context: Pick<ShortcutContext, 'activeSurface'>,
  { isOpen, surface }: Pick<StateAwarePaneShortcutInput, 'isOpen' | 'surface'>,
) => isOpen && context.activeSurface !== surface;

export const getStateAwarePaneShortcutLabel = (
  context: Pick<ShortcutContext, 'activeSurface'>,
  input: Pick<StateAwarePaneShortcutInput, 'focusLabel' | 'isOpen' | 'surface' | 'toggleLabel'>,
) => shouldFocusOpenPaneFromShortcut(context, input) ? input.focusLabel : input.toggleLabel;

export const runStateAwarePaneShortcut = (
  context: Pick<ShortcutContext, 'activeSurface'>,
  input: StateAwarePaneShortcutInput,
) => {
  if (shouldFocusOpenPaneFromShortcut(context, input)) {
    input.focus();
    return;
  }

  input.toggle();
};

type UseAppShortcutsInput = {
  createThreadFromShortcut: () => void;
  focusChat: () => void;
  focusEditor: () => void;
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
  showChatPane: boolean;
  showEditorPane: boolean;
  showSidebarPreview: boolean;
  showTerminalPane: boolean;
  toggleSidebar: () => void;
};

export const useAppShortcuts = ({
  createThreadFromShortcut,
  focusChat,
  focusEditor,
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
  showChatPane,
  showEditorPane,
  showSidebarPreview,
  showTerminalPane,
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
    label: context => getStateAwarePaneShortcutLabel(context, {
      focusLabel: 'Focus chat',
      isOpen: showChatPane,
      surface: 'chat',
      toggleLabel: 'Toggle chat pane',
    }),
    surface: 'chat',
    isEnabled: () => hasChatPaneTarget,
    run: context => runStateAwarePaneShortcut(context, {
      focus: focusChat,
      focusLabel: 'Focus chat',
      isOpen: showChatPane,
      surface: 'chat',
      toggle: handleChatPaneToggle,
      toggleLabel: 'Toggle chat pane',
    }),
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
    id: 'terminal.globalToggle',
    label: 'Toggle global terminal',
    surface: 'terminal',
    isEnabled: () => hasGeneralTerminalTarget,
    run: handleGeneralTerminalToggle,
  },
  {
    id: 'terminal.toggle',
    label: context => getStateAwarePaneShortcutLabel(context, {
      focusLabel: 'Focus terminal pane',
      isOpen: showTerminalPane,
      surface: 'terminal',
      toggleLabel: 'Toggle terminal pane',
    }),
    surface: 'terminal',
    isEnabled: () => hasTerminalTarget,
    run: context => runStateAwarePaneShortcut(context, {
      focus: focusTerminal,
      focusLabel: 'Focus terminal pane',
      isOpen: showTerminalPane,
      surface: 'terminal',
      toggle: handleTerminalPaneToggle,
      toggleLabel: 'Toggle terminal pane',
    }),
  },
  {
    id: 'terminal.expandToggle',
    label: 'Expand terminal pane',
    surface: 'terminal',
    isEnabled: () => hasTerminalTarget && showTerminalPane,
    isVisible: () => showTerminalPane,
    run: () => {
      handleMainPaneMaximizeToggle('terminal');
      window.requestAnimationFrame(focusTerminal);
    },
  },
  {
    id: 'editor.toggle',
    label: context => getStateAwarePaneShortcutLabel(context, {
      focusLabel: 'Focus editor pane',
      isOpen: showEditorPane,
      surface: 'editor',
      toggleLabel: 'Toggle editor pane',
    }),
    surface: 'editor',
    isEnabled: () => hasEditorTarget,
    run: context => runStateAwarePaneShortcut(context, {
      focus: focusEditor,
      focusLabel: 'Focus editor pane',
      isOpen: showEditorPane,
      surface: 'editor',
      toggle: handleEditorPaneToggle,
      toggleLabel: 'Toggle editor pane',
    }),
  },
  {
    id: 'editor.expandToggle',
    label: 'Expand editor pane',
    surface: 'editor',
    isEnabled: () => hasEditorTarget && showEditorPane,
    isVisible: () => showEditorPane,
    run: () => {
      handleMainPaneMaximizeToggle('editor');
    },
  },
], [
  createThreadFromShortcut,
  focusChat,
  focusEditor,
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
  showChatPane,
  showEditorPane,
  showSidebarPreview,
  showTerminalPane,
  toggleSidebar,
]);
