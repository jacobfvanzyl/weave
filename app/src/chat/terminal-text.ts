import type { TerminalExitStatus } from '@/host/protocol';

// CSI (colours, cursor movement), OSC (titles, links) and the other escape sequences a command
// writes for a terminal, none of which a transcript shows.
const ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[PX^_][^\u001b]*(?:\u001b\\)?|[@-Z\\-_]|$)/g;
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** A line as a terminal leaves it: each carriage return writes over it from the start. */
const overwrite = (line: string) => {
  if (!line.includes('\r')) return line;
  let shown = '';
  for (const part of line.split('\r')) shown = part + shown.slice(part.length);
  return shown;
};

/** A command's output as plain text: escape sequences removed, and lines rewritten as a terminal would. */
export function terminalText(raw: string): string {
  return raw
    .replace(ESCAPES, '')
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map(overwrite)
    .join('\n')
    .replace(CONTROLS, '');
}

/** How a command ended, as a transcript says it. */
export function exitText(status: TerminalExitStatus): string {
  if (status.signal) return `Killed by ${status.signal}`;
  if (status.exitCode === 0) return 'Exited';
  if (status.exitCode != null) return `Exited with code ${status.exitCode}`;
  return 'Ended';
}
