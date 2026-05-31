import { ConnectionApp } from '../components/connection/ConnectionApp';
import { ChatPage } from '../components/chat/ChatPage';
import { createWebConnectionAdapter } from '../lib/web-connection-adapter';

const webConnectionAdapter = createWebConnectionAdapter();

export const WebConnectionApp = () => (
  <ConnectionApp
    adapter={webConnectionAdapter}
    settingsButtonClassName="h-8 w-8 text-muted-foreground hover:text-foreground"
    tokenStorageDescription="Saved in this browser's local storage."
    renderConnected={connectionSettingsButton => (
      <ChatPage connectionSettingsButton={connectionSettingsButton} />
    )}
  />
);
