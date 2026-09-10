import type { ComponentProps } from 'react';
import { nativeTerminalEnabled } from '@/terminal/native-terminal';
import { NativeTerminalView } from './native-terminal-view';
import { XtermTerminalView } from './xterm-terminal-view';
export function TerminalView(props: ComponentProps<typeof XtermTerminalView>) {
  return nativeTerminalEnabled && props.output
    ? <NativeTerminalView focusRequest={props.focusRequest} output={props.output} readOnly={props.readOnly} onInput={props.onInput} onResize={props.onResize} />
    : <XtermTerminalView {...props} />;
}
