import React from 'react';
import ReactDOM from 'react-dom/client';
import { getClientAppDefinition } from '@weave/client/lib/client-app';
import { configureMastraConnection } from '@weave/client/lib/mastra-client';
import './styles.css';

const clientApp = getClientAppDefinition();

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

const renderBootstrapError = (error: unknown) => {
  console.error(error);
  const message = error instanceof Error ? error.message : 'Unknown startup error.';
  renderRoot(
    <main className="grid h-dvh place-items-center bg-background px-6 text-foreground">
      <div className="w-full max-w-md space-y-3 rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-2xl">
        <h1 className="text-lg font-semibold">{clientApp.displayName} failed to start</h1>
        <p className="break-words text-sm text-muted-foreground">{message}</p>
      </div>
    </main>,
  );
};

const bootstrap = async () => {
  const desktopBridge = window.weaveDesktop;
  if (!desktopBridge?.getConnectionSettings) {
    await renderWebFallback();
    return;
  }

  const root = document.documentElement;
  document.title = clientApp.displayName;
  root.dataset.theme = 'mocha';
  root.dataset.weaveClientApp = clientApp.id;
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

void bootstrap().catch(renderBootstrapError);
