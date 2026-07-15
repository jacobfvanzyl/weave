import type {
  TerminalHostEvent as ProtocolTerminalHostEvent,
  TerminalSessionKind,
  TerminalWindowRecord,
} from '@weave/protocol';

export type { TerminalSessionKind, TerminalWindowRecord } from '@weave/protocol';

export type TerminalStartInput = {
  kind: TerminalSessionKind;
  terminalId: string;
  projectId?: string;
  workspaceId?: string;
  portalId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
};

export type TerminalTargetInput = Omit<TerminalStartInput, 'terminalId'> & {
  terminalId?: string;
};

export type TerminalClientMessage =
  | { type: 'snapshot'; requestId?: string }
  | ({ type: 'list'; requestId?: string } & TerminalTargetInput)
  | ({ type: 'create'; requestId?: string } & TerminalTargetInput)
  | ({ type: 'start' } & TerminalStartInput)
  | { type: 'input'; terminalId: string; data: string }
  | { type: 'resize'; terminalId: string; cols: number; rows: number }
  | { type: 'close'; terminalId: string }
  | { type: 'detach'; terminalId: string };

export type TerminalStartedEvent = Extract<ProtocolTerminalHostEvent, { type: 'started' }>;
export type TerminalHostEvent = ProtocolTerminalHostEvent;

export type TerminalStartResult = {
  sessionId: string;
  cwd: string;
};

export type TerminalTransport = {
  snapshot: (input?: TerminalTargetInput) => Promise<TerminalWindowRecord[]>;
  list: (input: TerminalTargetInput) => Promise<TerminalWindowRecord[]>;
  create: (input: TerminalTargetInput) => Promise<TerminalWindowRecord>;
  start: (input: TerminalStartInput) => Promise<TerminalStartResult>;
  input: (terminalId: string, data: string) => Promise<void>;
  resize: (terminalId: string, cols: number, rows: number) => Promise<void>;
  close: (terminalId: string, input?: TerminalTargetInput) => Promise<void>;
  detach: (terminalId: string) => Promise<void>;
  subscribe: (listener: (event: TerminalHostEvent) => void) => () => void;
};
