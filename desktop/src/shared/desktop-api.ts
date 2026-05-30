import type { TerminalHostEvent, TerminalStartInput, TerminalStartResult } from './terminal';
import type { EditorFile, EditorListResult, EditorTarget, EditorWriteResult } from './editor';

export type DesktopConnectionSettings = {
  mastraUrl: string;
  hasAuthToken: boolean;
};

export type DesktopConnectionInput = {
  mastraUrl: string;
  authToken?: string | null;
};

export type DesktopConnectionTestResult =
  | { ok: true; user: { id: string; name: string } }
  | { ok: false; status?: number; error: string };

export type WeaveDesktopBridge = {
  getConnectionSettings: () => Promise<DesktopConnectionSettings>;
  saveConnectionSettings: (input: DesktopConnectionInput) => Promise<DesktopConnectionSettings>;
  testConnection: (input?: DesktopConnectionInput) => Promise<DesktopConnectionTestResult>;
  openExternal: (url: string) => Promise<void>;
  getPlatform: () => NodeJS.Platform;
  terminalStart: (input: TerminalStartInput) => Promise<TerminalStartResult>;
  terminalInput: (demiplaneId: string, data: string) => Promise<void>;
  terminalResize: (demiplaneId: string, cols: number, rows: number) => Promise<void>;
  terminalClose: (demiplaneId: string) => Promise<void>;
  terminalDetach: (demiplaneId: string) => Promise<void>;
  onTerminalEvent: (listener: (event: TerminalHostEvent) => void) => () => void;
  editorList: (target: EditorTarget, path?: string) => Promise<EditorListResult>;
  editorRead: (target: EditorTarget, path: string) => Promise<EditorFile>;
  editorWrite: (target: EditorTarget, path: string, content: string, version?: string) => Promise<EditorWriteResult>;
};
