import { mockScenarioFromLocation, useMockAlphaController, type MockScenario } from '@/app/use-mock-alpha-controller';
import { useLiveAlphaController } from '@/app/use-live-alpha-controller';
import { AlphaShell } from '@/components/alpha-shell';
import { TooltipProvider } from '@/components/ui/tooltip';

function LiveAlpha() {
  return <AlphaShell controller={useLiveAlphaController()} />;
}

function MockAlpha({ scenario }: { scenario: MockScenario }) {
  return <AlphaShell controller={useMockAlphaController(scenario)} />;
}

export function App() {
  const mockScenario = mockScenarioFromLocation();

  return (
    <TooltipProvider>
      {mockScenario
        ? <MockAlpha scenario={mockScenario} />
        : <LiveAlpha />}
    </TooltipProvider>
  );
}
