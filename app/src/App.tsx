import { useHostController } from '@/app/use-host-controller';
import { mockScenarioFromLocation, useMockController } from '@/app/use-mock-controller';
import { useNativeKeyboard } from '@/app/use-native-keyboard';
import { usePairingLink } from '@/app/use-pairing-link';
import { useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { SurfaceApp } from '@/surface/surface-app';
import { deviceSurfaceLink } from '@/surface/surface-link';
import { TooltipProvider } from '@/components/ui/tooltip';

function HostApp() {
  const [surfaceLink] = useState(deviceSurfaceLink);
  return <AppShell controller={useHostController()} pairingOffer={usePairingLink()} surfaceLink={surfaceLink} />;
}

function MockApp() {
  const [surfaceLink] = useState(deviceSurfaceLink);
  return <AppShell controller={useMockController(mockScenarioFromLocation())} surfaceLink={surfaceLink} />;
}

// The app talks to its paired Hosts; `?mock=<scenario>` (or a debug build's `--mock`) runs it on
// fixtures instead, for UI work. `?surface` is a Surface's page (WVE-183), which the native shell
// opens on a connected display and a browser in another tab, beside a phone's at `?mock=…&idiom=phone`.
export function App() {
  const search = new URLSearchParams(location.search);
  if (search.has('surface')) return <TooltipProvider><SurfaceApp /></TooltipProvider>;
  return <DeviceApp mock={search.has('mock')} />;
}

function DeviceApp({ mock }: { mock: boolean }) {
  useNativeKeyboard();
  return (
    <TooltipProvider>
      {mock ? <MockApp /> : <HostApp />}
    </TooltipProvider>
  );
}
