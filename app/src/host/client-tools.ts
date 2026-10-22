import type { ClientToolResult } from './protocol';

/** A client tool (ADR 0009) as this device runs it for an agent: its arguments, then MCP's `CallToolResult`. */
export type ClientTool = (args: Record<string, unknown>) => Promise<ClientToolResult>;

export const toolText = (text: string): ClientToolResult => ({ content: [{ type: 'text', text }] });

export const toolError = (text: string): ClientToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** `clipboard_write {text}`: puts the text on the device's clipboard, as the TUI does. */
export const clipboardWrite = (write: (text: string) => Promise<void>): ClientTool => async (args) => {
  if (typeof args.text !== 'string') return toolError('clipboard_write needs `text`, a string.');
  try {
    await write(args.text);
    return toolText('Copied to the clipboard.');
  } catch (error) {
    return toolError(`Couldn't copy to the clipboard: ${error instanceof Error ? error.message : String(error)}`);
  }
};
