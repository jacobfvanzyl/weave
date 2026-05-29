import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { ServerCog } from 'lucide-react';
import { Providers } from '@weave/client/app/providers';
import { ChatPage } from '@weave/client/components/chat/ChatPage';
import { Button } from '@weave/client/components/ui/button';
import { configureMastraConnection } from '@weave/client/lib/mastra-client';
import { queryClient } from '@weave/client/lib/query-client';
import type {
  DesktopConnectionInput,
  DesktopConnectionSettings,
  DesktopConnectionTestResult,
} from '../shared/desktop-api';
import { ConnectionDialog, ConnectionScreen } from './ConnectionForm';

type ConnectionStatus = 'checking' | 'connected' | 'disconnected';

type DesktopController = {
  settings: DesktopConnectionSettings;
  status: ConnectionStatus;
  error?: string;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  saveConnection: (input: DesktopConnectionInput) => Promise<DesktopConnectionTestResult>;
  testConnection: (input?: DesktopConnectionInput) => Promise<DesktopConnectionTestResult>;
};

const DesktopContext = createContext<DesktopController | undefined>(undefined);

const useDesktop = () => {
  const context = useContext(DesktopContext);
  if (!context) throw new Error('Desktop context is missing.');
  return context;
};

const RootLayout = () => (
  <>
    <Outlet />
    <DesktopSettingsDialog />
  </>
);

const DesktopSettingsDialog = () => {
  const desktop = useDesktop();
  return (
    <ConnectionDialog
      open={desktop.settingsOpen}
      settings={desktop.settings}
      error={desktop.error}
      onOpenChange={desktop.setSettingsOpen}
      onSave={desktop.saveConnection}
      onTest={desktop.testConnection}
    />
  );
};

const ConnectRoute = () => {
  const desktop = useDesktop();
  return (
    <ConnectionScreen
      settings={desktop.settings}
      status={desktop.status}
      error={desktop.error}
      onSave={desktop.saveConnection}
      onTest={desktop.testConnection}
    />
  );
};

const ChatRoute = () => {
  const desktop = useDesktop();

  if (desktop.status === 'checking') {
    return (
      <div className="grid h-dvh place-items-center bg-background text-sm text-muted-foreground">
        Connecting...
      </div>
    );
  }

  if (desktop.status === 'disconnected') {
    void router.navigate({ to: '/connect' });
    return null;
  }

  return (
    <div className="weave-desktop-shell">
      <ChatPage />
      <Button
        aria-label="Connection settings"
        className="weave-desktop-settings-button"
        size="icon"
        variant="ghost"
        onClick={() => desktop.setSettingsOpen(true)}
      >
        <ServerCog size={17} />
      </Button>
    </div>
  );
};

const rootRoute = createRootRoute({ component: RootLayout });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: ChatRoute });
const connectRoute = createRoute({ getParentRoute: () => rootRoute, path: '/connect', component: ConnectRoute });
const routeTree = rootRoute.addChildren([indexRoute, connectRoute]);
const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export const DesktopApp = ({ initialSettings }: { initialSettings: DesktopConnectionSettings }) => {
  const [settings, setSettings] = useState(initialSettings);
  const [status, setStatus] = useState<ConnectionStatus>('checking');
  const [error, setError] = useState<string | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const applySettings = useCallback((nextSettings: DesktopConnectionSettings) => {
    setSettings(nextSettings);
    configureMastraConnection({ mastraUrl: nextSettings.mastraUrl, authToken: null });
    queryClient.clear();
  }, []);

  const testConnection = useCallback(async (input?: DesktopConnectionInput) => {
    const result = await window.weaveDesktop.testConnection(input);
    if (result.ok) setError(undefined);
    else setError(result.error);
    return result;
  }, []);

  const saveConnection = useCallback(async (input: DesktopConnectionInput) => {
    const nextSettings = await window.weaveDesktop.saveConnectionSettings(input);
    applySettings(nextSettings);
    const result = await window.weaveDesktop.testConnection();

    if (result.ok) {
      setStatus('connected');
      setError(undefined);
      setSettingsOpen(false);
      await router.navigate({ to: '/' });
    } else {
      setStatus('disconnected');
      setError(result.error);
      await router.navigate({ to: '/connect' });
    }

    return result;
  }, [applySettings]);

  useEffect(() => {
    let cancelled = false;

    const checkConnection = async () => {
      const result = await window.weaveDesktop.testConnection();
      if (cancelled) return;

      if (result.ok) {
        setStatus('connected');
        setError(undefined);
        await router.navigate({ to: '/' });
      } else {
        setStatus('disconnected');
        setError(result.error);
        await router.navigate({ to: '/connect' });
      }
    };

    void checkConnection();

    return () => {
      cancelled = true;
    };
  }, []);

  const controller = useMemo<DesktopController>(
    () => ({
      settings,
      status,
      error,
      settingsOpen,
      setSettingsOpen,
      saveConnection,
      testConnection,
    }),
    [error, saveConnection, settings, settingsOpen, status, testConnection],
  );

  return (
    <DesktopContext.Provider value={controller}>
      <Providers>
        <RouterProvider router={router} />
      </Providers>
    </DesktopContext.Provider>
  );
};
