import { useCallback, useEffect, useRef } from 'react';
import { useAppShellStore } from '../../stores/app-shell-store';
import { useTerminalStore } from '../../stores/terminal-store';
import type { MainPane } from '../../stores/workspace-surface-store';
import { isPortraitViewportNow, threadSidebarWidthPx } from '../workspace/useMainPaneMetrics';

type ShellLayoutInput = {
  editorTargetKey?: string;
  hasEditorTarget: boolean;
  hasGeneralTerminalTarget: boolean;
  isPortraitViewport: boolean;
  maximizedPane: MainPane | null;
  pageWidth: number;
  terminalWorkspaceId?: string;
  visibleMainPaneMinimumWidthPx: number;
};

export const useShellLayout = ({
  editorTargetKey,
  hasEditorTarget,
  hasGeneralTerminalTarget,
  isPortraitViewport,
  maximizedPane,
  pageWidth,
  terminalWorkspaceId,
  visibleMainPaneMinimumWidthPx,
}: ShellLayoutInput) => {
  const isSidebarPinnedOpen = useAppShellStore(state => state.isSidebarPinnedOpen);
  const isSidebarPreviewOpen = useAppShellStore(state => state.isSidebarPreviewOpen);
  const isGeneralTerminalOpen = useAppShellStore(state => state.isGeneralTerminalOpen);
  const isGeneralTerminalActive = useAppShellStore(state => state.isGeneralTerminalActive);
  const editorFocusRequest = useAppShellStore(state => state.editorFocusRequest);
  const terminalFocusRequest = useAppShellStore(state => state.terminalFocusRequest);
  const generalTerminalFocusRequest = useAppShellStore(state => state.generalTerminalFocusRequest);
  const setSidebarPinnedOpen = useAppShellStore(state => state.setSidebarPinnedOpen);
  const setSidebarPreviewOpen = useAppShellStore(state => state.setSidebarPreviewOpen);
  const setGeneralTerminalOpen = useAppShellStore(state => state.setGeneralTerminalOpen);
  const setGeneralTerminalActive = useAppShellStore(state => state.setGeneralTerminalActive);
  const requestEditorFocus = useAppShellStore(state => state.requestEditorFocus);
  const requestTerminalFocus = useAppShellStore(state => state.requestTerminalFocus);
  const requestGeneralTerminalFocus = useAppShellStore(state => state.requestGeneralTerminalFocus);
  const activeTerminalWorkspaceIds = useTerminalStore(state => state.activeTerminalWorkspaceIds);
  const setWorkspaceTerminalActive = useTerminalStore(state => state.setWorkspaceTerminalActive);
  const sidebarPreviewCloseTimeoutRef = useRef<number | undefined>(undefined);
  const workspaceWidthWithPinnedSidebar = Math.max(0, pageWidth - threadSidebarWidthPx);
  const canPinSidebarWithMainPanes = !isPortraitViewport
    && maximizedPane === null
    && workspaceWidthWithPinnedSidebar >= visibleMainPaneMinimumWidthPx;
  const isSidebarAutoHidden = isSidebarPinnedOpen && !canPinSidebarWithMainPanes;
  const isSidebarOpen = isSidebarPinnedOpen && canPinSidebarWithMainPanes;
  const canPreviewSidebar = !isSidebarOpen;
  const showSidebarPreview = canPreviewSidebar && isSidebarPreviewOpen;
  const showPinnedSidebarToggle = isSidebarOpen;
  const showHeaderSidebarToggle = !isSidebarOpen;
  const hasTerminalTarget = Boolean(terminalWorkspaceId);
  const hasActiveTerminal = terminalWorkspaceId ? activeTerminalWorkspaceIds.has(terminalWorkspaceId) : false;

  useEffect(() => {
    if (isSidebarOpen) setSidebarPreviewOpen(false);
  }, [isSidebarOpen, setSidebarPreviewOpen]);

  useEffect(() => {
    if (!hasGeneralTerminalTarget) {
      setGeneralTerminalOpen(false);
      setGeneralTerminalActive(false);
    }
  }, [hasGeneralTerminalTarget, setGeneralTerminalActive, setGeneralTerminalOpen]);

  useEffect(() => {
    if (!hasEditorTarget) return;
  }, [editorTargetKey, hasEditorTarget]);

  useEffect(() => () => {
    if (sidebarPreviewCloseTimeoutRef.current !== undefined) {
      window.clearTimeout(sidebarPreviewCloseTimeoutRef.current);
    }
  }, []);

  const clearSidebarPreviewCloseTimeout = useCallback(() => {
    if (sidebarPreviewCloseTimeoutRef.current === undefined) return;
    window.clearTimeout(sidebarPreviewCloseTimeoutRef.current);
    sidebarPreviewCloseTimeoutRef.current = undefined;
  }, []);

  const openSidebarPreview = useCallback(() => {
    if (!canPreviewSidebar) return;
    clearSidebarPreviewCloseTimeout();
    setSidebarPreviewOpen(true);
  }, [canPreviewSidebar, clearSidebarPreviewCloseTimeout, setSidebarPreviewOpen]);

  const closeSidebarPreview = useCallback(() => {
    clearSidebarPreviewCloseTimeout();
    setSidebarPreviewOpen(false);
  }, [clearSidebarPreviewCloseTimeout, setSidebarPreviewOpen]);

  const scheduleSidebarPreviewClose = useCallback(() => {
    clearSidebarPreviewCloseTimeout();
    sidebarPreviewCloseTimeoutRef.current = window.setTimeout(() => {
      sidebarPreviewCloseTimeoutRef.current = undefined;
      setSidebarPreviewOpen(false);
    }, 140);
  }, [clearSidebarPreviewCloseTimeout, setSidebarPreviewOpen]);

  const toggleSidebar = useCallback(() => {
    clearSidebarPreviewCloseTimeout();
    if (isPortraitViewport) {
      setSidebarPinnedOpen(false);
      setSidebarPreviewOpen(!isSidebarPreviewOpen);
      return;
    }

    if (!canPinSidebarWithMainPanes) {
      setSidebarPinnedOpen(true);
      setSidebarPreviewOpen(!isSidebarPreviewOpen);
      return;
    }

    setSidebarPreviewOpen(false);
    setSidebarPinnedOpen(!isSidebarPinnedOpen);
  }, [
    canPinSidebarWithMainPanes,
    clearSidebarPreviewCloseTimeout,
    isPortraitViewport,
    isSidebarPinnedOpen,
    isSidebarPreviewOpen,
    setSidebarPinnedOpen,
    setSidebarPreviewOpen,
  ]);

  const closeSidebar = useCallback(() => {
    clearSidebarPreviewCloseTimeout();
    setSidebarPinnedOpen(false);
    setSidebarPreviewOpen(false);
  }, [clearSidebarPreviewCloseTimeout, setSidebarPinnedOpen, setSidebarPreviewOpen]);

  const focusTerminal = useCallback(() => {
    if (!hasTerminalTarget) return;
    requestTerminalFocus();
  }, [hasTerminalTarget, requestTerminalFocus]);

  const toggleGeneralTerminal = useCallback(() => {
    if (!hasGeneralTerminalTarget) return;
    setGeneralTerminalOpen(!isGeneralTerminalOpen);
  }, [hasGeneralTerminalTarget, isGeneralTerminalOpen, setGeneralTerminalOpen]);

  const hideGeneralTerminal = useCallback(() => {
    setGeneralTerminalOpen(false);
  }, [setGeneralTerminalOpen]);

  const focusGeneralTerminal = useCallback(() => {
    if (!hasGeneralTerminalTarget) return;
    setGeneralTerminalOpen(true);
    requestGeneralTerminalFocus();
  }, [hasGeneralTerminalTarget, requestGeneralTerminalFocus, setGeneralTerminalOpen]);

  const focusEditor = useCallback(() => {
    if (!hasEditorTarget) return;
    requestEditorFocus();
  }, [hasEditorTarget, requestEditorFocus]);

  const handleTerminalSessionActiveChange = useCallback((isActive: boolean) => {
    if (!terminalWorkspaceId) return;
    setWorkspaceTerminalActive(terminalWorkspaceId, isActive);
  }, [setWorkspaceTerminalActive, terminalWorkspaceId]);

  const handleGeneralTerminalSessionActiveChange = useCallback((isActive: boolean) => {
    setGeneralTerminalActive(isActive);
  }, [setGeneralTerminalActive]);

  return {
    closeSidebar,
    closeSidebarPreview,
    editorFocusRequest,
    focusEditor,
    focusGeneralTerminal,
    focusTerminal,
    handleGeneralTerminalSessionActiveChange,
    handleTerminalSessionActiveChange,
    hasActiveTerminal,
    hasEditorTarget,
    hasGeneralTerminalTarget,
    hasTerminalTarget,
    hideGeneralTerminal,
    isGeneralTerminalActive,
    isGeneralTerminalOpen,
    isSidebarAutoHidden,
    isSidebarOpen,
    isSidebarPinnedOpen,
    openSidebarPreview,
    scheduleSidebarPreviewClose,
    showHeaderSidebarToggle,
    showPinnedSidebarToggle,
    showSidebarPreview,
    generalTerminalFocusRequest,
    terminalFocusRequest,
    toggleGeneralTerminal,
    toggleSidebar,
  };
};
