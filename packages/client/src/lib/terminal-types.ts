export type TerminalStartInput = {
  planeId: string;
  demiplaneId: string;
  cols?: number;
  rows?: number;
};

export type TerminalClientMessage =
  | ({ type: 'start' } & TerminalStartInput)
  | { type: 'input'; demiplaneId: string; data: string }
  | { type: 'resize'; demiplaneId: string; cols: number; rows: number }
  | { type: 'close'; demiplaneId: string }
  | { type: 'detach'; demiplaneId: string };

export type TerminalStartedEvent = {
  type: 'started';
  demiplaneId: string;
  sessionId: string;
  cwd: string;
  pid?: number;
  cols: number;
  rows: number;
};

export type TerminalHostEvent =
  | TerminalStartedEvent
  | { type: 'output'; demiplaneId: string; data: string }
  | { type: 'replay'; demiplaneId: string; data: string }
  | { type: 'title'; demiplaneId: string; title: string }
  | { type: 'exit'; demiplaneId: string; exitCode?: number; signal?: number | string }
  | { type: 'error'; demiplaneId: string; error: string };

export type TerminalStartResult = {
  sessionId: string;
  cwd: string;
};

export type TerminalTransport = {
  start: (input: TerminalStartInput) => Promise<TerminalStartResult>;
  input: (demiplaneId: string, data: string) => Promise<void>;
  resize: (demiplaneId: string, cols: number, rows: number) => Promise<void>;
  close: (demiplaneId: string) => Promise<void>;
  detach: (demiplaneId: string) => Promise<void>;
  subscribe: (listener: (event: TerminalHostEvent) => void) => () => void;
};
