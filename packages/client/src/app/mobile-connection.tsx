import { ConnectionApp } from '../components/connection/ConnectionApp';
import { WeaveAppShell } from '../components/app-shell/WeaveAppShell';
import { clientAppDefinitions, getClientAppDefinition, type ClientAppDefinition, type ClientAppId } from '../lib/client-app';
import { createMobileConnectionAdapter } from '../lib/mobile-connection-adapter';

const mobileConnectionAdapter = createMobileConnectionAdapter();

type MobileConnectionAppProps = {
  clientApp?: ClientAppId | ClientAppDefinition;
};

export const ClientAppMobileConnectionApp = ({ clientApp }: MobileConnectionAppProps = {}) => {
  const app = getClientAppDefinition(clientApp);
  return (
  <ConnectionApp
    adapter={mobileConnectionAdapter}
    settingsButtonClassName="h-8 w-8 text-muted-foreground hover:text-foreground"
    tokenStorageDescription="Saved in this iOS app's Preferences storage."
    renderConnected={connectionSettingsButton => (
      <WeaveAppShell clientApp={app} connectionSettingsButton={connectionSettingsButton} />
    )}
  />
  );
};

export const MobileConnectionApp = ClientAppMobileConnectionApp;

export const FlareMobileConnectionApp = () => (
  <ClientAppMobileConnectionApp clientApp={clientAppDefinitions.flare} />
);

export const CoppermindMobileConnectionApp = () => (
  <ClientAppMobileConnectionApp clientApp={clientAppDefinitions.coppermind} />
);
