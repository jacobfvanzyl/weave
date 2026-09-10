import type { ComponentProps } from 'react';
import { nativeTerminalAvailable } from '@/terminal/native-terminal';
import { NativeTerminalView } from './native-terminal-view';

type TerminalViewProps = Omit<ComponentProps<typeof NativeTerminalView>, 'output'> & {
  output?: ComponentProps<typeof NativeTerminalView>['output'];
};
export function TerminalView({ output, ...props }: TerminalViewProps) {
  if (!nativeTerminalAvailable) return <div role='status' className='flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground'>Native terminals require the Electron or iPad app.</div>;
  if (!output) return <div role='status' className='flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground'>Terminal is not attached.</div>;
  return <NativeTerminalView output={output} {...props} />;
}
