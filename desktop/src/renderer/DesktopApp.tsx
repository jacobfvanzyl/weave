import { useMemo } from 'react';
import { Providers } from '@weave/client/app/providers';
import { ConnectionApp } from '@weave/client/components/connection/ConnectionApp';
import type { ConnectionAdapter } from '@weave/client/lib/connection-types';
import type {
  DesktopConnectionSettings,
} from '../shared/desktop-api';

export const DesktopApp = ({ initialSettings }: { initialSettings: DesktopConnectionSettings }) => {
  const adapter = useMemo<ConnectionAdapter>(
    () => ({
      getSettings: () => window.weaveDesktop.getConnectionSettings(),
      saveSettings: input => window.weaveDesktop.saveConnectionSettings(input),
      testConnection: input => window.weaveDesktop.testConnection(input),
      getClientAuthToken: () => null,
    }),
    [],
  );

  return (
    <Providers>
      <ConnectionApp
        adapter={adapter}
        initialSettings={initialSettings}
        shellClassName="weave-desktop-shell"
        settingsButtonClassName="weave-desktop-settings-button"
        tokenStorageDescription="Tokens are encrypted by the main process when available."
      />
    </Providers>
  );
};
