export type TerminalSessionKind = 'workspace' | 'general';

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

export type TerminalWindowRecord = {
  terminalId: string;
  scopeId: string;
  slot: number;
  kind: TerminalSessionKind;
  cwd: string;
  title: string;
  processName?: string;
  portalId?: string;
  rootId?: string;
  projectId?: string;
  workspaceId?: string;
};

export type TerminalStartResult = {
  sessionId: string;
  cwd: string;
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

export type TerminalHostEvent =
  | {
      type: 'started';
      terminalId: string;
      workspaceId?: string;
      sessionId: string;
      cwd: string;
      pid?: number;
      cols: number;
      rows: number;
    }
  | { type: 'windows'; requestId?: string; windows: TerminalWindowRecord[] }
  | { type: 'created'; requestId?: string; terminalId: string; workspaceId?: string; window: TerminalWindowRecord }
  | { type: 'output'; terminalId: string; workspaceId?: string; data: string }
  | { type: 'replay'; terminalId: string; workspaceId?: string; data: string }
  | { type: 'title'; terminalId: string; workspaceId?: string; title: string }
  | { type: 'exit'; terminalId: string; workspaceId?: string; exitCode?: number; signal?: number | string }
  | { type: 'error'; requestId?: string; terminalId: string; workspaceId?: string; error: string };
