import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { ServerCog } from 'lucide-react';
import { type ClientAppInputId, getBuildClientAppId } from '../../lib/client-app';
import { activateClientSessionStores } from '../../lib/client-session-activation';
import { createClientSessionIdentity } from '../../lib/client-session';
import type {
  ConnectionAdapter,
  ConnectionInput,
  ConnectionSettings,
  ConnectionStatus,
  ConnectionTestResult,
} from '../../lib/connection-types';
import { configureMastraConnection } from '../../lib/mastra-client';
import { queryClient } from '../../lib/query-client';
import { Button } from '../ui/button';
import { WeaveAppShell } from '../app-shell/WeaveAppShell';
import { ConnectionDialog, ConnectionScreen } from './ConnectionForm';

const fallbackSettings: ConnectionSettings = {
  mastraUrl: 'http://localhost:4111',
  hasAuthToken: false,
};

type ConnectionAppProps = {
  adapter: ConnectionAdapter;
  initialSettings?: ConnectionSettings;
  shellClassName?: string;
  settingsButtonClassName?: string;
  tokenStorageDescription?: string;
  connectionDetails?: ReactNode;
  clientApp?: ClientAppInputId;
  renderConnected?: (settingsButton: ReactNode) => ReactNode;
};

const ClientSessionBoundary = ({
  children,
  identity,
}: {
  children: ReactNode;
  identity: ReturnType<typeof createClientSessionIdentity>;
}) => {
  const identityKey = `${identity.clientAppId}:${identity.serverUrl}:${identity.ownerId}`;
  const [readyIdentityKey, setReadyIdentityKey] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setReadyIdentityKey(undefined);
    void activateClientSessionStores(identity).then((didActivate) => {
      if (!cancelled && didActivate) setReadyIdentityKey(identityKey);
    });
    return () => {
      cancelled = true;
    };
  }, [identityKey]);

  if (readyIdentityKey !== identityKey) {
    return (
      <div className="grid h-dvh place-items-center bg-background text-sm text-muted-foreground">
        Restoring session...
      </div>
    );
  }

  return children;
};

export const ConnectionApp = ({
  adapter,
  initialSettings,
  shellClassName = 'relative h-dvh overflow-hidden',
  settingsButtonClassName = 'fixed right-16 top-3 z-40',
  tokenStorageDescription,
  connectionDetails,
  clientApp = getBuildClientAppId(),
  renderConnected,
}: ConnectionAppProps) => {
  const [settings, setSettings] = useState(initialSettings ?? fallbackSettings);
  const [status, setStatus] = useState<ConnectionStatus>('checking');
  const [error, setError] = useState<string | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [connectedUser, setConnectedUser] = useState<{ id: string; name: string }>();

  const applySettings = useCallback((nextSettings: ConnectionSettings) => {
    setSettings(nextSettings);
    configureMastraConnection({
      mastraUrl: nextSettings.mastraUrl,
      authToken: adapter.getClientAuthToken?.() ?? null,
    });
    queryClient.clear();
  }, [adapter],);

  const testConnection = useCallback(async (input?: ConnectionInput) => {
    const result = await adapter.testConnection(input);
    if (result.ok) setError(undefined);
    else setError(result.error);
    return result;
  }, [adapter],);

  const saveConnection = useCallback(async (input: ConnectionInput): Promise<ConnectionTestResult> => {
      setStatus('checking');
      setConnectedUser(undefined);
    const nextSettings = await adapter.saveSettings(input);
    applySettings(nextSettings);
    const result = await adapter.testConnection();

    if (result.ok) {
        setConnectedUser(result.user);
      setStatus('connected');
      setError(undefined);
      setSettingsOpen(false);
    } else {
      setStatus('disconnected');
      setError(result.error);
    }

    return result;
  }, [adapter, applySettings],);

  useEffect(() => {
    let cancelled = false;

    const checkConnection = async () => {
      try {
        const nextSettings = await adapter.getSettings();
        if (cancelled) return;

        applySettings(nextSettings);
        const result = await adapter.testConnection();
        if (cancelled) return;

        if (result.ok) {
          setConnectedUser(result.user);
          setStatus('connected');
          setError(undefined);
        } else {
          setConnectedUser(undefined);
          setStatus('disconnected');
          setError(result.error);
        }
      } catch (error) {
        if (cancelled) return;
        setConnectedUser(undefined);
        setStatus('disconnected');
        setError(error instanceof Error ? error.message : 'Connection failed.');
      }
    };

    void checkConnection();

    return () => {
      cancelled = true;
    };
  }, [adapter, applySettings]);

  const connectionProps = useMemo(
    () => ({
      settings,
      status,
      error,
      tokenStorageDescription,
      connectionDetails,
      onSave: saveConnection,
      onTest: testConnection,
    }),
    [connectionDetails,error, saveConnection, settings, status, testConnection, tokenStorageDescription],
  );

  if (status === 'checking') {
    return (
      <div className="grid h-dvh place-items-center bg-background text-sm text-muted-foreground">
        Connecting...
      </div>
    );
  }

  if (status === 'disconnected') {
    return <ConnectionScreen {...connectionProps} />;
  }

  if (!connectedUser) {
    return (
      <div className="grid h-dvh place-items-center bg-background text-sm text-muted-foreground">Connecting...</div>
    );
  }

  const sessionIdentity = createClientSessionIdentity(clientApp, settings.mastraUrl, connectedUser.id);

  const settingsButton = (
    <Button
      aria-label="Connection settings"
      className={settingsButtonClassName}
      size="icon"
      variant="ghost"
      onClick={() => setSettingsOpen(true)}
    >
      <ServerCog size={17} />
    </Button>
  );

  return (
    <>
      <ClientSessionBoundary identity={sessionIdentity}>
        <div className={shellClassName}>
        {renderConnected?.(settingsButton) ?? (
          <>
            <WeaveAppShell clientApp={clientApp} />
            {settingsButton}
          </>
        )}
      </div>
      </ClientSessionBoundary>
      <ConnectionDialog
        {...connectionProps}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </>
  );
};
