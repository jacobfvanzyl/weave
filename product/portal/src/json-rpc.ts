export type JsonRpcId = string | number | null;
export type JsonRpcMessage = {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export const request = (id: JsonRpcId, method: string, params?: unknown): JsonRpcMessage => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

export const result = (id: JsonRpcId, value: unknown): JsonRpcMessage => ({ jsonrpc: '2.0', id, result: value });
export const error = (id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcMessage => ({
  jsonrpc: '2.0',
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

export const parseJsonRpcMessage = (value: unknown): JsonRpcMessage => {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON-RPC message must be an object.');
  }
  const message = parsed as Record<string, unknown>;
  if (message.jsonrpc !== '2.0') throw new Error('JSON-RPC version must be 2.0.');
  if (message.method !== undefined && typeof message.method !== 'string') {
    throw new Error('JSON-RPC method must be a string.');
  }
  if (
    message.id !== undefined && message.id !== null && typeof message.id !== 'string' && typeof message.id !== 'number'
  ) {
    throw new Error('JSON-RPC id is invalid.');
  }
  return parsed as JsonRpcMessage;
};

export const idKey = (id: JsonRpcId) => `${typeof id}:${String(id)}`;
