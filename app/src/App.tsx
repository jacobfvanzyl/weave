import { mockScenarioFromLocation, useMockController } from '@/app/use-mock-controller';
import { useNativeKeyboard } from '@/app/use-native-keyboard';
import { AppShell } from '@/components/app-shell';
import { TooltipProvider } from '@/components/ui/tooltip';

// Until the app talks to a Host (WVE-100), it runs on fixtures; `?mock=` picks a scenario.
export function App() {
  useNativeKeyboard();
  const controller = useMockController(mockScenarioFromLocation());
  return (
    <TooltipProvider>
      <AppShell controller={controller} />
    </TooltipProvider>
  );
}
