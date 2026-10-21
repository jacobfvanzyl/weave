import { useHostController } from '@/app/use-host-controller';
import { mockScenarioFromLocation, useMockController } from '@/app/use-mock-controller';
import { useNativeKeyboard } from '@/app/use-native-keyboard';
import { usePairingLink } from '@/app/use-pairing-link';
import { AppShell } from '@/components/app-shell';
import { TooltipProvider } from '@/components/ui/tooltip';

function HostApp() {
  return <AppShell controller={useHostController()} pairingOffer={usePairingLink()} />;
}

function MockApp() {
  return <AppShell controller={useMockController(mockScenarioFromLocation())} />;
}

// The app talks to its paired Hosts; `?mock=<scenario>` (or a debug build's `--mock`) runs it on
// fixtures instead, for UI work.
export function App() {
  useNativeKeyboard();
  const mock = new URLSearchParams(location.search).has('mock');
  return (
    <TooltipProvider>
      {mock ? <MockApp /> : <HostApp />}
    </TooltipProvider>
  );
}
