import React from 'react';
import ReactDOM from 'react-dom/client';
import { configureMastraConnection } from '../../../web/src/lib/mastra-client';
import './styles.css';

const root = document.documentElement;
root.dataset.theme = 'mocha';
root.dataset.weaveWindowType = 'electron';
root.classList.add('dark');
root.style.colorScheme = 'dark';

const bootstrap = async () => {
  const settings = await window.weaveDesktop.getConnectionSettings();
  configureMastraConnection({ mastraUrl: settings.mastraUrl, authToken: null });

  const { DesktopApp } = await import('./DesktopApp');
  const { applyTheme, useThemeStore } = await import('../../../web/src/stores/theme-store');
  useThemeStore.getState().setMode('dark');
  applyTheme('dark');

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <DesktopApp initialSettings={settings} />
    </React.StrictMode>,
  );
};

void bootstrap();
