export const TERMINAL_EVENT_METHOD = "terminal.event" as const;

export const TERMINAL_RPC_METHODS = [
  "terminal.list",
  "terminal.create",
  "terminal.snapshot",
  "terminal.attach",
  "terminal.input",
  "terminal.resize",
  "terminal.detach",
  "terminal.close",
] as const;

export type TerminalRpcMethod = (typeof TERMINAL_RPC_METHODS)[number];
export type TerminalAttachmentMode = "observe" | "control";
export type TerminalStatus = "running" | "exited";

export type TerminalSummary = {
  terminalId: string;
  workspaceId: string;
  title: string;
  status: TerminalStatus;
  cols: number;
  rows: number;
  processName?: string;
  exitCode?: number;
};

export type TerminalControllerState =
  { controlled: false } | { controlled: true; attachmentId: string };

export type TerminalSnapshot = {
  terminal: TerminalSummary;
  generation: string;
  cursor: number;
  retainedFrom: number;
  data: string;
  controller: TerminalControllerState;
};

export type TerminalAttachment = {
  attachmentId: string;
  mode: TerminalAttachmentMode;
};

export type TerminalEvent =
  | { type: "output"; data: string }
  | { type: "title"; title: string }
  | (TerminalControllerState & { type: "control" })
  | { type: "exit"; exitCode?: number }
  | { type: "resync"; retainedFrom: number };

export type TerminalNotification = {
  attachmentId: string;
  terminalId: string;
  workspaceId: string;
  generation: string;
  sequence: number;
  event: TerminalEvent;
};

export const TERMINAL_ERROR_CODES = [
  "TERMINAL_UNAVAILABLE",
  "TERMINAL_CONTROLLED",
  "TERMINAL_ATTACHMENT_UNAVAILABLE",
  "TERMINAL_CONTROL_REQUIRED",
  "TERMINAL_REPLAY_GAP",
  "TERMINAL_BACKPRESSURE",
  "TERMINAL_BACKEND_UNAVAILABLE",
] as const;

export type TerminalErrorCode = (typeof TERMINAL_ERROR_CODES)[number];
export type TerminalErrorData = {
  domain: "terminal";
  code: TerminalErrorCode;
  workspaceId?: string;
  terminalId?: string;
  retainedFrom?: number;
};

export type TerminalRpcContracts = {
  "terminal.list": {
    params: { workspaceId: string };
    result: { terminals: TerminalSummary[] };
  };
  "terminal.create": {
    params: { workspaceId: string; cols?: number; rows?: number };
    result: { terminal: TerminalSummary };
  };
  "terminal.snapshot": {
    params: { workspaceId: string; terminalId: string };
    result: { snapshot: TerminalSnapshot };
  };
  "terminal.attach": {
    params: {
      workspaceId: string;
      terminalId: string;
      mode: TerminalAttachmentMode;
      cursor?: number;
    };
    result: { attachment: TerminalAttachment; snapshot: TerminalSnapshot };
  };
  "terminal.input": {
    params: {
      workspaceId: string;
      terminalId: string;
      attachmentId: string;
      data: string;
    };
    result: { accepted: true };
  };
  "terminal.resize": {
    params: {
      workspaceId: string;
      terminalId: string;
      attachmentId: string;
      cols: number;
      rows: number;
    };
    result: { accepted: true };
  };
  "terminal.detach": {
    params: {
      workspaceId: string;
      terminalId: string;
      attachmentId: string;
    };
    result: { detached: true };
  };
  "terminal.close": {
    params: {
      workspaceId: string;
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
  if (value !== "observe" && value !== "control") {
    throw new Error("mode must be observe or control.");
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
    workspaceId: string(input.workspaceId, "workspaceId"),
    title: string(input.title, "title", 1_024),
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

const controller = (value: unknown): TerminalControllerState => {
  const input = record(value, "Terminal controller state");
  if (input.controlled === false) return { controlled: false };
  if (input.controlled === true) {
    return {
      controlled: true,
      attachmentId: string(input.attachmentId, "attachmentId"),
    };
  }
  throw new Error("Terminal controller state is invalid.");
};

const snapshot = (value: unknown): TerminalSnapshot => {
  const input = record(value, "Terminal snapshot");
  return {
    terminal: summary(input.terminal),
    generation: string(input.generation, "generation"),
    cursor: integer(input.cursor, "cursor"),
    retainedFrom: integer(input.retainedFrom, "retainedFrom"),
    data:
      typeof input.data === "string"
        ? input.data
        : (() => {
            throw new Error("Terminal snapshot data must be a string.");
          })(),
    controller: controller(input.controller),
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
  const workspaceId = string(input.workspaceId, "workspaceId");
  switch (method) {
    case "terminal.list":
      return { workspaceId } as TerminalRpcParams<Method>;
    case "terminal.create": {
      const cols = optionalDimension(input.cols, "cols");
      const rows = optionalDimension(input.rows, "rows");
      return {
        workspaceId,
        ...(cols === undefined ? {} : { cols }),
        ...(rows === undefined ? {} : { rows }),
      } as TerminalRpcParams<Method>;
    }
    case "terminal.snapshot":
      return {
        workspaceId,
        terminalId: string(input.terminalId, "terminalId"),
      } as TerminalRpcParams<Method>;
    case "terminal.attach":
      return {
        workspaceId,
        terminalId: string(input.terminalId, "terminalId"),
        mode: mode(input.mode),
        ...(input.cursor === undefined
          ? {}
          : { cursor: integer(input.cursor, "cursor") }),
      } as TerminalRpcParams<Method>;
    case "terminal.input": {
      const data = rawData(input.data, "data");
      return {
        workspaceId,
        terminalId: string(input.terminalId, "terminalId"),
        attachmentId: string(input.attachmentId, "attachmentId"),
        data,
      } as TerminalRpcParams<Method>;
    }
    case "terminal.resize":
      return {
        workspaceId,
        terminalId: string(input.terminalId, "terminalId"),
        attachmentId: string(input.attachmentId, "attachmentId"),
        cols: dimension(input.cols, "cols"),
        rows: dimension(input.rows, "rows"),
      } as TerminalRpcParams<Method>;
    case "terminal.detach":
    case "terminal.close":
      return {
        workspaceId,
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
    case "output":
      return { type: "output", data: rawData(input.data, "data", 1_048_576) };
    case "title":
      return { type: "title", title: string(input.title, "title", 1_024) };
    case "control":
      return { type: "control", ...controller(input) };
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
    workspaceId: string(input.workspaceId, "workspaceId"),
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
    ...(input.workspaceId === undefined
      ? {}
      : { workspaceId: string(input.workspaceId, "workspaceId") }),
    ...(input.terminalId === undefined
      ? {}
      : { terminalId: string(input.terminalId, "terminalId") }),
    ...(input.retainedFrom === undefined
      ? {}
      : { retainedFrom: integer(input.retainedFrom, "retainedFrom") }),
  };
};
