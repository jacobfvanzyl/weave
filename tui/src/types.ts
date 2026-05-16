export type TuiConfig = {
  httpServerUrl?: string;
  authToken?: string;
  model?: string;
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

export type ResolvedWorkspace = Record<string, any> & {
  plane?: { id?: string; name?: string };
  demiplane?: { id?: string; name?: string; path?: string };
  thread?: { id?: string };
};

export type StreamChunk = {
  type: string;
  delta?: string;
  errorText?: string;
  toolName?: string;
  toolCallId?: string;
  id?: string;
  input?: unknown;
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
  | { type: 'assistant'; id?: string; rawText: string; renderedText?: string }
  | { type: 'tool'; toolName: string; toolCallId?: string }
  | { type: 'system'; text: string };

export type ConnectionStatus = 'connected' | 'not-connected';

export type AppState = {
  messages: RenderMessage[];
  status?: string;
  connectionStatus?: ConnectionStatus;
  modelDisplayName: string;
  contextPercent?: number;
  title: {
    plane: string;
    demiplane?: string;
    thread?: string;
  };
};
