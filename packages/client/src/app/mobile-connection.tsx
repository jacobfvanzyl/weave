import { ConnectionApp } from '../components/connection/ConnectionApp';
import { ChatPage } from '../components/chat/ChatPage';
import { createMobileConnectionAdapter } from '../lib/mobile-connection-adapter';

const mobileConnectionAdapter = createMobileConnectionAdapter();

export const MobileConnectionApp = () => (
  <ConnectionApp
    adapter={mobileConnectionAdapter}
    settingsButtonClassName="h-8 w-8 text-muted-foreground hover:text-foreground"
    tokenStorageDescription="Saved in this iOS app's Preferences storage."
    renderConnected={connectionSettingsButton => (
      <ChatPage connectionSettingsButton={connectionSettingsButton} />
    )}
  />
);
