import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeMode = 'light' | 'dark' | 'system';

type ThemeState = {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggleMode: () => void;
};

export const getResolvedTheme = (mode: ThemeMode) => {
  if (mode !== 'system') return mode;

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

export const applyTheme = (mode: ThemeMode) => {
  const resolvedTheme = getResolvedTheme(mode);
  const root = document.documentElement;

  root.dataset.theme = resolvedTheme === 'dark' ? 'mocha' : 'latte';
  root.classList.toggle('dark', resolvedTheme === 'dark');
  root.style.colorScheme = resolvedTheme;
};

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: 'system',
      setMode: mode => {
        applyTheme(mode);
        set({ mode });
      },
      toggleMode: () => {
        const nextMode = getResolvedTheme(get().mode) === 'dark' ? 'light' : 'dark';
        applyTheme(nextMode);
        set({ mode: nextMode });
      },
    }),
    {
      name: 'weave-theme',
      partialize: state => ({ mode: state.mode }),
      onRehydrateStorage: () => state => applyTheme(state?.mode ?? 'system'),
    },
  ),
);

if (typeof window !== 'undefined') {
  applyTheme(useThemeStore.getState().mode);

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const { mode } = useThemeStore.getState();
    if (mode === 'system') applyTheme(mode);
  });
}
