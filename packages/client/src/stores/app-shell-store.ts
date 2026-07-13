import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getClientAppStorageKey } from '../lib/client-app';
import {
  claimLegacyClientSessionStorage,
  type ClientSessionIdentity,
  createClientSessionPersistStorage,
  getClientSessionStorageKey,
  readClientSessionStorageValue,
  restoreClientSessionStorageValue,
} from '../lib/client-session';

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

const isPortraitViewportNow = () => typeof window !== 'undefined' && window.innerHeight > window.innerWidth; const initialAppShellState =() => ({
  isSidebarPinnedOpen: !isPortraitViewportNow(),
  isSidebarPreviewOpen: false,
  isGeneralTerminalOpen: false,
  isGeneralTerminalActive: false,
  isWindowStreamOpen: false,
  isWindowStreamActive: false,
  editorFocusRequest: 0,
  terminalFocusRequest: 0,
  generalTerminalFocusRequest: 0,
});

const normalizePersistedAppShellState = (value: unknown) => {
  const state = value && typeof value === 'object' ? (value as Partial<AppShellState>) : {};
  return {
    isSidebarPinnedOpen:
      typeof state.isSidebarPinnedOpen === 'boolean'
        ? state.isSidebarPinnedOpen
        : !isPortraitViewportNow(),
    isGeneralTerminalOpen:
      typeof state.isGeneralTerminalOpen === 'boolean' ? state.isGeneralTerminalOpen : false,
  };
};

export const useAppShellStore = create<AppShellState>()(
  persist(
    (set) => ({
      ...initialAppShellState(),
  setSidebarPinnedOpen: ( isSidebarPinnedOpen) => set({ isSidebarPinnedOpen }),
  setSidebarPreviewOpen: ( isSidebarPreviewOpen) => set({ isSidebarPreviewOpen }),
  setGeneralTerminalOpen: ( isGeneralTerminalOpen) => set({ isGeneralTerminalOpen }),
  setGeneralTerminalActive: ( isGeneralTerminalActive) => set({ isGeneralTerminalActive }),
  setWindowStreamOpen: ( isWindowStreamOpen) => set({ isWindowStreamOpen }),
  setWindowStreamActive: ( isWindowStreamActive) => set({ isWindowStreamActive }),
  requestEditorFocus: () => set((state) => ({ editorFocusRequest: state.editorFocusRequest + 1 })),
  requestTerminalFocus: () => set((state) => ({ terminalFocusRequest: state.terminalFocusRequest + 1, })),
  requestGeneralTerminalFocus: () => set((state) => ({ generalTerminalFocusRequest: state.generalTerminalFocusRequest + 1, })),
}),
    {
      name: getClientAppStorageKey('weave-shell-view'),
      version: 1,
      skipHydration: true,
      storage: createClientSessionPersistStorage(),
      migrate: normalizePersistedAppShellState,
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...normalizePersistedAppShellState(persistedState),
      }),
      partialize: (state) => ({
        isSidebarPinnedOpen: state.isSidebarPinnedOpen,
        isGeneralTerminalOpen: state.isGeneralTerminalOpen,
      }),
    },
  ),);

export const activateAppShellSession = async (identity: ClientSessionIdentity) => {
  const name = getClientSessionStorageKey('weave-shell-view', identity);
  claimLegacyClientSessionStorage(name, [getClientAppStorageKey('weave-shell-view')]);
  const persistedState = readClientSessionStorageValue(name);
  useAppShellStore.persist.setOptions({
    name,
    storage: createClientSessionPersistStorage(),
  });
  useAppShellStore.setState(initialAppShellState());
  restoreClientSessionStorageValue(name, persistedState);
  await useAppShellStore.persist.rehydrate();
};
