import { ConnectionApp } from '../components/connection/ConnectionApp';
import { createWebConnectionAdapter } from '../lib/web-connection-adapter';

const webConnectionAdapter = createWebConnectionAdapter();

export const WebConnectionApp = () => (
  <ConnectionApp
    adapter={webConnectionAdapter}
    settingsButtonClassName="fixed right-16 top-3 z-40"
    tokenStorageDescription="Saved in this browser's local storage."
  />
);
