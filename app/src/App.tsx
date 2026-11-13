import { useHostController } from '@/app/use-host-controller';
import { mockScenarioFromLocation, useMockController } from '@/app/use-mock-controller';
import { watchSoftKeyboard } from '@/app/use-soft-keyboard';
import { useEffect } from 'react';
import { AppShell } from '@/components/app-shell';
import { useMacShell } from '@/mac/shell';
import { TerminalCheck } from '@/mac/terminal-check';
import { TooltipProvider } from '@/components/ui/tooltip';

function HostApp() {
  const controller = useHostController();
  // In the app's shell, its `weave://` links, and on the Mac its menu bar and notifications (ADR 0032).
  const pairingOffer = useMacShell(controller);
  return <AppShell controller={controller} pairingOffer={pairingOffer} />;
}

function MockApp() {
  return <AppShell controller={useMockController(mockScenarioFromLocation())} />;
}

// The app talks to its Hosts through the Dispatcher it's paired with; `?mock=<scenario>` (or a
// debug build's `--mock`) runs it on fixtures instead, for UI work.
export function App() {
  const search = new URLSearchParams(location.search);
  // The Mac's app started by its terminal check (`scripts/mac-terminal-check.ts`): one terminal.
  const check = search.get('terminal-check');
  if (check) return <TerminalCheck terminal={check} />;
  return <DeviceApp mock={search.has('mock')} />;
}

function DeviceApp({ mock }: { mock: boolean }) {
  // The page follows a software keyboard, where there is one (WVE-221).
  useEffect(watchSoftKeyboard, []);
  return (
    <TooltipProvider>
      {mock ? <MockApp /> : <HostApp />}
    </TooltipProvider>
  );
}
