export type TerminalStartInput = {
  planeId: string;
  demiplaneId: string;
  cols?: number;
  rows?: number;
};

export type TerminalStartResult = {
  sessionId: string;
  cwd: string;
};

export type TerminalClientMessage =
  | ({ type: 'start' } & TerminalStartInput)
  | { type: 'input'; demiplaneId: string; data: string }
  | { type: 'resize'; demiplaneId: string; cols: number; rows: number }
  | { type: 'close'; demiplaneId: string }
  | { type: 'detach'; demiplaneId: string };

export type TerminalHostEvent =
  | {
      type: 'started';
      demiplaneId: string;
      sessionId: string;
      cwd: string;
      pid?: number;
      cols: number;
      rows: number;
    }
  | { type: 'output'; demiplaneId: string; data: string }
  | { type: 'replay'; demiplaneId: string; data: string }
  | { type: 'title'; demiplaneId: string; title: string }
  | { type: 'exit'; demiplaneId: string; exitCode?: number; signal?: number | string }
  | { type: 'error'; demiplaneId: string; error: string };
