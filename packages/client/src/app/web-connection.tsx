import { ConnectionApp } from '../components/connection/ConnectionApp';
import { WeaveAppShell } from '../components/app-shell/WeaveAppShell';
import { clientAppDefinitions, getClientAppDefinition, type ClientAppDefinition, type ClientAppId } from '../lib/client-app';
import { createWebConnectionAdapter } from '../lib/web-connection-adapter';

const webConnectionAdapter = createWebConnectionAdapter();

type WebConnectionAppProps = {
  clientApp?: ClientAppId | ClientAppDefinition;
};

export const ClientAppWebConnectionApp = ({ clientApp }: WebConnectionAppProps = {}) => {
  const app = getClientAppDefinition(clientApp);
  return (
  <ConnectionApp
    adapter={webConnectionAdapter}
    settingsButtonClassName="h-8 w-8 text-muted-foreground hover:text-foreground"
    tokenStorageDescription="Saved in this browser's local storage."
    renderConnected={connectionSettingsButton => (
      <WeaveAppShell clientApp={app} connectionSettingsButton={connectionSettingsButton} />
    )}
  />
  );
};

export const WebConnectionApp = ClientAppWebConnectionApp;

export const FlareConnectionApp = () => (
  <ClientAppWebConnectionApp clientApp={clientAppDefinitions.flare} />
);

export const CoppermindConnectionApp = () => (
  <ClientAppWebConnectionApp clientApp={clientAppDefinitions.coppermind} />
);
