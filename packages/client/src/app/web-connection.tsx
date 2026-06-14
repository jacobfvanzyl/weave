import { ConnectionApp } from '../components/connection/ConnectionApp';
import { WeaveAppShell } from '../components/app-shell/WeaveAppShell';
import { createWebConnectionAdapter } from '../lib/web-connection-adapter';

const webConnectionAdapter = createWebConnectionAdapter();

export const WebConnectionApp = () => (
  <ConnectionApp
    adapter={webConnectionAdapter}
    settingsButtonClassName="h-8 w-8 text-muted-foreground hover:text-foreground"
    tokenStorageDescription="Saved in this browser's local storage."
    renderConnected={connectionSettingsButton => (
      <WeaveAppShell connectionSettingsButton={connectionSettingsButton} />
    )}
  />
);
