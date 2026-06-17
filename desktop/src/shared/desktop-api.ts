import type {
  TerminalHostEvent,
  TerminalStartInput,
  TerminalStartResult,
  TerminalTargetInput,
  TerminalWindowRecord,
} from './terminal';
import type { EditorFile, EditorListResult, EditorOperationResult, EditorTarget, EditorWriteResult } from './editor';

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
  terminalSnapshot: () => Promise<TerminalWindowRecord[]>;
  terminalList: (input: TerminalTargetInput) => Promise<TerminalWindowRecord[]>;
  terminalCreate: (input: TerminalTargetInput) => Promise<TerminalWindowRecord>;
  terminalStart: (input: TerminalStartInput) => Promise<TerminalStartResult>;
  terminalInput: (terminalId: string, data: string) => Promise<void>;
  terminalResize: (terminalId: string, cols: number, rows: number) => Promise<void>;
  terminalClose: (terminalId: string) => Promise<void>;
  terminalDetach: (terminalId: string) => Promise<void>;
  onTerminalEvent: (listener: (event: TerminalHostEvent) => void) => () => void;
  editorList: (target: EditorTarget, path?: string) => Promise<EditorListResult>;
  editorRead: (target: EditorTarget, path: string) => Promise<EditorFile>;
  editorWrite: (target: EditorTarget, path: string, content: string, version?: string) => Promise<EditorWriteResult>;
  editorMkdir: (target: EditorTarget, path: string) => Promise<EditorOperationResult>;
  editorMove: (target: EditorTarget, fromPath: string, toPath: string, overwrite?: boolean) => Promise<EditorOperationResult>;
  editorDelete: (target: EditorTarget, path: string, recursive?: boolean) => Promise<EditorOperationResult>;
};
