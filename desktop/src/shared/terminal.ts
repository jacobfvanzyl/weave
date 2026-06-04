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

export type TerminalStartResult = {
  sessionId: string;
  cwd: string;
};

export type TerminalClientMessage =
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
  | { type: 'output'; terminalId: string; workspaceId?: string; data: string }
  | { type: 'replay'; terminalId: string; workspaceId?: string; data: string }
  | { type: 'title'; terminalId: string; workspaceId?: string; title: string }
  | { type: 'exit'; terminalId: string; workspaceId?: string; exitCode?: number; signal?: number | string }
  | { type: 'error'; terminalId: string; workspaceId?: string; error: string };
