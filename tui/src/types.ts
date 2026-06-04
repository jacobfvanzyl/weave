export type TuiConfig = {
  httpServerUrl?: string;
  wsServerUrl?: string;
  authToken?: string;
  portalId?: string;
  portal?: {
    portalId?: string;
    portalToken?: string;
    name?: string;
    mounts?: Array<{ projectId: string; localPath: string }>;
    roots?: Array<{ id: string; name: string; path: string }>;
  };
};

export type ParsedArgs = {
  command?: string;
  flags: Record<string, string | boolean>;
};

export type ChatMessage = {
  id: string;
  role: string;
  parts?: Array<Record<string, unknown>>;
};

export type ChatThread = {
  id: string;
  title?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

export type PortalConnection = {
  portalId: string;
  name?: string;
  status?: string;
};

export type ResolvedWorkspace = Record<string, any> & {
  project?: { id?: string; name?: string };
  workspace?: { id?: string; name?: string; path?: string };
  thread?: { id?: string };
  adHoc?: boolean;
};

export type StreamChunk = {
  type: string;
  delta?: string;
  errorText?: string;
  toolName?: string;
  toolCallId?: string;
  id?: string;
  input?: unknown;
  output?: unknown;
  result?: unknown;
  isError?: boolean;
  usage?: TokenUsage;
  totalUsage?: TokenUsage;
  response?: {
    modelId?: string;
  };
};

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
};

export type RenderMessage =
  | { type: 'user'; id?: string; text: string }
  | { type: 'assistant'; id?: string; rawText: string; renderedText?: string; pending?: boolean; spinnerFrame?: number }
  | { type: 'tool'; toolName: string; toolCallId?: string; input?: unknown; output?: unknown; isError?: boolean }
  | { type: 'system'; text: string };

export type ConnectionStatus = 'connected' | 'not-connected';

export type AppState = {
  messages: RenderMessage[];
  status?: string;
  connectionStatus?: ConnectionStatus;
  modelDisplayName: string;
  contextPercent?: number;
  title: {
    project?: string;
    workspace?: string;
    thread?: string;
  };
};
