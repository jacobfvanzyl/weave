import { useMemo } from 'react';
import { Providers } from '@weave/client/app/providers';
import { WeaveAppShell } from '@weave/client';
import { ConnectionApp } from '@weave/client/components/connection/ConnectionApp';
import type { ConnectionAdapter } from '@weave/client/lib/connection-types';
import type {
  DesktopConnectionSettings,
} from '../shared/desktop-api';
import { PortalStatusIndicator } from './PortalStatusIndicator';
import { adoptedLocalPortalId } from './portal-status';
import { useDesktopPortalStatus } from './useDesktopPortalStatus';

export const DesktopApp = ({ initialSettings }: { initialSettings: DesktopConnectionSettings }) => {
  const portalStatus = useDesktopPortalStatus();
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
        settingsButtonClassName="h-8 w-8 text-muted-foreground hover:text-foreground"
        tokenStorageDescription="Tokens are encrypted by the main process when available."
        connectionDetails={(
          <PortalStatusIndicator
            status={portalStatus.status}
            retrying={portalStatus.retrying}
            onRetry={portalStatus.retry}
          />
        )}
        renderConnected={connectionSettingsButton => (
          <WeaveAppShell
            adoptedLocalPortalId={adoptedLocalPortalId(portalStatus.status)}
            connectionSettingsButton={connectionSettingsButton}
          />
        )}
      />
    </Providers>
  );
};
