import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ServerCog } from 'lucide-react';
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
  renderConnected?: (settingsButton: ReactNode) => ReactNode;
};

export const ConnectionApp = ({
  adapter,
  initialSettings,
  shellClassName = 'relative h-dvh overflow-hidden',
  settingsButtonClassName = 'fixed right-16 top-3 z-40',
  tokenStorageDescription,
  renderConnected,
}: ConnectionAppProps) => {
  const [settings, setSettings] = useState(initialSettings ?? fallbackSettings);
  const [status, setStatus] = useState<ConnectionStatus>('checking');
  const [error, setError] = useState<string | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const applySettings = useCallback((nextSettings: ConnectionSettings) => {
    setSettings(nextSettings);
    configureMastraConnection({
      mastraUrl: nextSettings.mastraUrl,
      authToken: adapter.getClientAuthToken?.() ?? null,
    });
    queryClient.clear();
  }, [adapter]);

  const testConnection = useCallback(async (input?: ConnectionInput) => {
    const result = await adapter.testConnection(input);
    if (result.ok) setError(undefined);
    else setError(result.error);
    return result;
  }, [adapter]);

  const saveConnection = useCallback(async (input: ConnectionInput): Promise<ConnectionTestResult> => {
    const nextSettings = await adapter.saveSettings(input);
    applySettings(nextSettings);
    const result = await adapter.testConnection();

    if (result.ok) {
      setStatus('connected');
      setError(undefined);
      setSettingsOpen(false);
    } else {
      setStatus('disconnected');
      setError(result.error);
    }

    return result;
  }, [adapter, applySettings]);

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
          setStatus('connected');
          setError(undefined);
        } else {
          setStatus('disconnected');
          setError(result.error);
        }
      } catch (error) {
        if (cancelled) return;
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
      onSave: saveConnection,
      onTest: testConnection,
    }),
    [error, saveConnection, settings, status, testConnection, tokenStorageDescription],
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
      <div className={shellClassName}>
        {renderConnected?.(settingsButton) ?? (
          <>
            <WeaveAppShell />
            {settingsButton}
          </>
        )}
      </div>
      <ConnectionDialog
        {...connectionProps}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </>
  );
};
