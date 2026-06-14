import { create } from 'zustand';

type AppShellState = {
  isSidebarPinnedOpen: boolean;
  isSidebarPreviewOpen: boolean;
  isGeneralTerminalOpen: boolean;
  isGeneralTerminalActive: boolean;
  isWindowStreamOpen: boolean;
  isWindowStreamActive: boolean;
  editorFocusRequest: number;
  terminalFocusRequest: number;
  generalTerminalFocusRequest: number;
  setSidebarPinnedOpen: (isOpen: boolean) => void;
  setSidebarPreviewOpen: (isOpen: boolean) => void;
  setGeneralTerminalOpen: (isOpen: boolean) => void;
  setGeneralTerminalActive: (isActive: boolean) => void;
  setWindowStreamOpen: (isOpen: boolean) => void;
  setWindowStreamActive: (isActive: boolean) => void;
  requestEditorFocus: () => void;
  requestTerminalFocus: () => void;
  requestGeneralTerminalFocus: () => void;
};

const isPortraitViewportNow = () => typeof window !== 'undefined' && window.innerHeight > window.innerWidth;

export const useAppShellStore = create<AppShellState>()(set => ({
  isSidebarPinnedOpen: !isPortraitViewportNow(),
  isSidebarPreviewOpen: false,
  isGeneralTerminalOpen: false,
  isGeneralTerminalActive: false,
  isWindowStreamOpen: false,
  isWindowStreamActive: false,
  editorFocusRequest: 0,
  terminalFocusRequest: 0,
  generalTerminalFocusRequest: 0,
  setSidebarPinnedOpen: isSidebarPinnedOpen => set({ isSidebarPinnedOpen }),
  setSidebarPreviewOpen: isSidebarPreviewOpen => set({ isSidebarPreviewOpen }),
  setGeneralTerminalOpen: isGeneralTerminalOpen => set({ isGeneralTerminalOpen }),
  setGeneralTerminalActive: isGeneralTerminalActive => set({ isGeneralTerminalActive }),
  setWindowStreamOpen: isWindowStreamOpen => set({ isWindowStreamOpen }),
  setWindowStreamActive: isWindowStreamActive => set({ isWindowStreamActive }),
  requestEditorFocus: () => set(state => ({ editorFocusRequest: state.editorFocusRequest + 1 })),
  requestTerminalFocus: () => set(state => ({ terminalFocusRequest: state.terminalFocusRequest + 1 })),
  requestGeneralTerminalFocus: () => set(state => ({ generalTerminalFocusRequest: state.generalTerminalFocusRequest + 1 })),
}));
