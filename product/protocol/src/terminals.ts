import { terminalBytes, TERMINAL_CODEC } from './terminal-wire.ts';
export const TERMINAL_EVENT_METHOD = "terminal.event" as const;

export const TERMINAL_RPC_METHODS = [
  "terminal.list",
  "terminal.create",
  "terminal.snapshot",
  "terminal.attach",
  "terminal.input",
  "terminal.history",
  "terminal.resize",
  "terminal.detach",
  "terminal.close",
] as const;

export type TerminalRpcMethod = (typeof TERMINAL_RPC_METHODS)[number];
export type TerminalAttachmentMode = "observe" | "shared";
export type TerminalStatus = "running" | "exited";

export type TerminalSummary = {
  terminalId: string;
  executionContextId: string;
  title: string;
  initialDirectory?: string;
  currentDirectory?: string;
  status: TerminalStatus;
  cols: number;
  rows: number;
  processName?: string;
  exitCode?: number;
};

export type TerminalSnapshot = {
  terminal: TerminalSummary;
  generation: string;
  cursor: number;
  retainedFrom: number;
  data: Uint8Array;
  historyPages?: number;
  historyToken?: string;
  codec: typeof TERMINAL_CODEC;
};

export type TerminalAttachment = {
  attachmentId: string;
  mode: TerminalAttachmentMode;
};

export type TerminalEvent =
  | { type: "output"; data: Uint8Array }
  | { type: "screen"; terminal: TerminalSummary; data: Uint8Array; historyPages?: number; historyToken?: string }
  | { type: "directory"; currentDirectory: string }
  | { type: "title"; title: string }
  | { type: "exit"; exitCode?: number }
  | { type: "resync"; retainedFrom: number };

export type TerminalNotification = {
  attachmentId: string;
  terminalId: string;
  executionContextId: string;
  generation: string;
  sequence: number;
  event: TerminalEvent;
};

export const TERMINAL_ERROR_CODES = [
  "TERMINAL_UNAVAILABLE",
  "TERMINAL_ATTACHMENT_UNAVAILABLE",
  "TERMINAL_WRITE_REQUIRED",
  "TERMINAL_REPLAY_GAP",
  "TERMINAL_BACKPRESSURE",
  "TERMINAL_SERVICE_UNAVAILABLE",
] as const;

export type TerminalErrorCode = (typeof TERMINAL_ERROR_CODES)[number];
export type TerminalErrorData = {
  domain: "terminal";
  code: TerminalErrorCode;
  executionContextId?: string;
  terminalId?: string;
  retainedFrom?: number;
};

export type TerminalRpcContracts = {
  "terminal.list": {
    params: { executionContextId: string };
    result: { terminals: TerminalSummary[] };
  };
  "terminal.create": {
    params: { executionContextId: string; cols?: number; rows?: number };
    result: { terminal: TerminalSummary };
  };
  "terminal.snapshot": {
    params: { executionContextId: string; terminalId: string };
    result: { snapshot: TerminalSnapshot };
  };
  "terminal.attach": {
    params: {
      executionContextId: string;
      terminalId: string;
      mode: TerminalAttachmentMode;
      cursor?: number;
    };
    result: { attachment: TerminalAttachment; snapshot: TerminalSnapshot };
  };
  "terminal.history": {
    params: { executionContextId: string; terminalId: string; attachmentId: string; page: number; token: string };
    result: { data: Uint8Array; finished: boolean };
  };
  "terminal.input": {
    params: {
      executionContextId: string;
      terminalId: string;
      attachmentId: string;
      data: Uint8Array;
    };
    result: { accepted: true };
  };
  "terminal.resize": {
    params: {
      executionContextId: string;
      terminalId: string;
      attachmentId: string;
      cols: number;
      rows: number;
    };
    result: { accepted: true };
  };
  "terminal.detach": {
    params: {
      executionContextId: string;
      terminalId: string;
      attachmentId: string;
    };
    result: { detached: true };
  };
  "terminal.close": {
    params: {
      executionContextId: string;
      terminalId: string;
      attachmentId: string;
    };
    result: { closed: true };
  };
};

export type TerminalRpcParams<Method extends TerminalRpcMethod> =
  TerminalRpcContracts[Method]["params"];
export type TerminalRpcResult<Method extends TerminalRpcMethod> =
  TerminalRpcContracts[Method]["result"];

const record = (value: unknown, context: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const string = (value: unknown, name: string, maximum = 512) => {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(
      `${name} must be a non-empty string of at most ${maximum} characters.`,
    );
  }
  return value;
};

const rawData = (value: unknown, name: string, maximumBytes = 65_536) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  if (new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw new Error(`${name} must be at most ${maximumBytes} bytes.`);
  }
  return value;
};

const integer = (
  value: unknown,
  name: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
) => {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value as number;
};

const dimension = (value: unknown, name: string) =>
  integer(value, name, 2, 1_000);

const optionalDimension = (value: unknown, name: string) =>
  value === undefined ? undefined : dimension(value, name);

const mode = (value: unknown): TerminalAttachmentMode => {
  if (value !== "observe" && value !== "shared") {
    throw new Error("mode must be observe or shared.");
  }
  return value;
};

const status = (value: unknown): TerminalStatus => {
  if (value !== "running" && value !== "exited") {
    throw new Error("Terminal status is invalid.");
  }
  return value;
};

const summary = (value: unknown): TerminalSummary => {
  const input = record(value, "Terminal summary");
  return {
    terminalId: string(input.terminalId, "terminalId"),
    executionContextId: string(input.executionContextId, "executionContextId"),
    title: string(input.title, "title", 1_024),
    ...(input.initialDirectory === undefined ? {} : { initialDirectory: string(input.initialDirectory, "initialDirectory", 16384) }),
    ...(input.currentDirectory === undefined ? {} : { currentDirectory: string(input.currentDirectory, "currentDirectory", 16384) }),
    status: status(input.status),
    cols: dimension(input.cols, "cols"),
    rows: dimension(input.rows, "rows"),
    ...(input.processName === undefined
      ? {}
      : { processName: string(input.processName, "processName", 1_024) }),
    ...(input.exitCode === undefined
      ? {}
      : { exitCode: integer(input.exitCode, "exitCode", -255, 255) }),
  };
};

const snapshot = (value: unknown): TerminalSnapshot => {
  const input = record(value, "Terminal snapshot");
  return {
    terminal: summary(input.terminal),
    generation: string(input.generation, "generation"),
    cursor: integer(input.cursor, "cursor"),
    retainedFrom: integer(input.retainedFrom, "retainedFrom"),
    data: terminalBytes(input.data),
    ...(input.historyToken === undefined ? {} : { historyToken: string(input.historyToken, "historyToken") }),
    ...(input.historyPages === undefined ? {} : { historyPages: integer(input.historyPages, "historyPages", 0, 10000) }),
    codec: input.codec === TERMINAL_CODEC ? TERMINAL_CODEC : (() => { throw new Error('Terminal codec mismatch; update Host and clients together'); })(),
  };
};

const attachment = (value: unknown): TerminalAttachment => {
  const input = record(value, "Terminal attachment");
  return {
    attachmentId: string(input.attachmentId, "attachmentId"),
    mode: mode(input.mode),
  };
};

export const parseTerminalRpcParams = <Method extends TerminalRpcMethod>(
  method: Method,
  value: unknown,
): TerminalRpcParams<Method> => {
  const input = record(value, `${method} params`);
  const executionContextId = string(input.executionContextId, "executionContextId");
  switch (method) {
    case "terminal.list":
      return { executionContextId } as TerminalRpcParams<Method>;
    case "terminal.create": {
      const cols = optionalDimension(input.cols, "cols");
      const rows = optionalDimension(input.rows, "rows");
      return {
        executionContextId,
        ...(cols === undefined ? {} : { cols }),
        ...(rows === undefined ? {} : { rows }),
      } as TerminalRpcParams<Method>;
    }
    case "terminal.snapshot":
      return {
        executionContextId,
        terminalId: string(input.terminalId, "terminalId"),
      } as TerminalRpcParams<Method>;
    case "terminal.attach":
      return {
        executionContextId,
        terminalId: string(input.terminalId, "terminalId"),
        mode: mode(input.mode),
        ...(input.cursor === undefined
          ? {}
          : { cursor: integer(input.cursor, "cursor") }),
      } as TerminalRpcParams<Method>;
    case "terminal.history":
      return { executionContextId, terminalId: string(input.terminalId, "terminalId"), attachmentId: string(input.attachmentId, "attachmentId"), page: integer(input.page, "page", 0, 10000), token: string(input.token, "token") } as TerminalRpcParams<Method>;
    case "terminal.input": {
      const data = terminalBytes(input.data, 65_536);
      if (!data.byteLength) throw new Error("Terminal input data must not be empty");
      return {
        executionContextId,
        terminalId: string(input.terminalId, "terminalId"),
        attachmentId: string(input.attachmentId, "attachmentId"),
        data,
      } as TerminalRpcParams<Method>;
    }
    case "terminal.resize":
      return {
        executionContextId,
        terminalId: string(input.terminalId, "terminalId"),
        attachmentId: string(input.attachmentId, "attachmentId"),
        cols: dimension(input.cols, "cols"),
        rows: dimension(input.rows, "rows"),
      } as TerminalRpcParams<Method>;
    case "terminal.detach":
    case "terminal.close":
      return {
        executionContextId,
        terminalId: string(input.terminalId, "terminalId"),
        attachmentId: string(input.attachmentId, "attachmentId"),
      } as TerminalRpcParams<Method>;
  }
};

export const parseTerminalRpcResult = <Method extends TerminalRpcMethod>(
  method: Method,
  value: unknown,
): TerminalRpcResult<Method> => {
  const input = record(value, `${method} result`);
  switch (method) {
    case "terminal.list":
      if (!Array.isArray(input.terminals))
        throw new Error("terminals must be an array.");
      return {
        terminals: input.terminals.map(summary),
      } as TerminalRpcResult<Method>;
    case "terminal.create":
      return { terminal: summary(input.terminal) } as TerminalRpcResult<Method>;
    case "terminal.snapshot":
      return {
        snapshot: snapshot(input.snapshot),
      } as TerminalRpcResult<Method>;
    case "terminal.attach":
      return {
        attachment: attachment(input.attachment),
        snapshot: snapshot(input.snapshot),
      } as TerminalRpcResult<Method>;
    case "terminal.history":
      if (typeof input.finished !== 'boolean') throw new Error('Invalid terminal history completion');
      return { data: terminalBytes(input.data), finished: input.finished } as TerminalRpcResult<Method>;
    case "terminal.input":
    case "terminal.resize":
      if (input.accepted !== true) throw new Error("accepted must be true.");
      return { accepted: true } as TerminalRpcResult<Method>;
    case "terminal.detach":
      if (input.detached !== true) throw new Error("detached must be true.");
      return { detached: true } as TerminalRpcResult<Method>;
    case "terminal.close":
      if (input.closed !== true) throw new Error("closed must be true.");
      return { closed: true } as TerminalRpcResult<Method>;
  }
};

const terminalEvent = (value: unknown): TerminalEvent => {
  const input = record(value, "Terminal event");
  switch (input.type) {
    case "screen":
      return { type: "screen", terminal: summary(input.terminal), data: terminalBytes(input.data), ...(input.historyToken === undefined ? {} : { historyToken: string(input.historyToken, "historyToken"), historyPages: integer(input.historyPages, "historyPages", 0, 10000) }) };
    case "output":
      return { type: "output", data: terminalBytes(input.data, 1_048_576) };
    case "directory":
      return { type: "directory", currentDirectory: string(input.currentDirectory, "currentDirectory", 16384) };
    case "title":
      return { type: "title", title: string(input.title, "title", 1_024) };
    case "exit":
      return {
        type: "exit",
        ...(input.exitCode === undefined
          ? {}
          : { exitCode: integer(input.exitCode, "exitCode", -255, 255) }),
      };
    case "resync":
      return {
        type: "resync",
        retainedFrom: integer(input.retainedFrom, "retainedFrom"),
      };
    default:
      throw new Error("Terminal event type is invalid.");
  }
};

export const parseTerminalNotification = (
  method: typeof TERMINAL_EVENT_METHOD,
  value: unknown,
): TerminalNotification => {
  if (method !== TERMINAL_EVENT_METHOD)
    throw new Error("Terminal notification method is invalid.");
  const input = record(value, "Terminal notification");
  return {
    attachmentId: string(input.attachmentId, "attachmentId"),
    terminalId: string(input.terminalId, "terminalId"),
    executionContextId: string(input.executionContextId, "executionContextId"),
    generation: string(input.generation, "generation"),
    sequence: integer(input.sequence, "sequence", 1),
    event: terminalEvent(input.event),
  };
};

export const parseTerminalErrorData = (value: unknown): TerminalErrorData => {
  const input = record(value, "Terminal error data");
  if (input.domain !== "terminal")
    throw new Error("Terminal error domain is invalid.");
  if (!TERMINAL_ERROR_CODES.includes(input.code as TerminalErrorCode)) {
    throw new Error("Terminal error code is invalid.");
  }
  return {
    domain: "terminal",
    code: input.code as TerminalErrorCode,
    ...(input.executionContextId === undefined
      ? {}
      : { executionContextId: string(input.executionContextId, "executionContextId") }),
    ...(input.terminalId === undefined
      ? {}
      : { terminalId: string(input.terminalId, "terminalId") }),
    ...(input.retainedFrom === undefined
      ? {}
      : { retainedFrom: integer(input.retainedFrom, "retainedFrom") }),
  };
};
