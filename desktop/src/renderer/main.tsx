import React from 'react';
import ReactDOM from 'react-dom/client';
import { configureMastraConnection } from '@weave/client/lib/mastra-client';
import './styles.css';

const renderRoot = (children: React.ReactNode) => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      {children}
    </React.StrictMode>,
  );
};

const renderWebFallback = async () => {
  const { Providers } = await import('@weave/client/app/providers');
  const { WebConnectionApp } = await import('@weave/client/app/web-connection');

  renderRoot(
    <Providers>
      <WebConnectionApp />
    </Providers>,
  );
};

const bootstrap = async () => {
  const desktopBridge = window.weaveDesktop;
  if (!desktopBridge?.getConnectionSettings) {
    await renderWebFallback();
    return;
  }

  const root = document.documentElement;
  root.dataset.theme = 'mocha';
  root.dataset.weaveWindowType = 'electron';
  root.classList.add('dark');
  root.style.colorScheme = 'dark';

  const settings = await desktopBridge.getConnectionSettings();
  configureMastraConnection({ mastraUrl: settings.mastraUrl, authToken: null });

  const { DesktopApp } = await import('./DesktopApp');
  const { applyTheme, useThemeStore } = await import('@weave/client/stores/theme-store');
  useThemeStore.getState().setMode('dark');
  applyTheme('dark');

  renderRoot(<DesktopApp initialSettings={settings} />);
};

void bootstrap();
