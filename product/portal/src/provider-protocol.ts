import type { AgentProcess } from './agent-process.ts';

const objectFrom = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export const ACP_INITIALIZE_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: {
    elicitation: { form: {}, url: {} },
    plan: {},
    session: {
      compaction: {},
      configOptions: { boolean: {} },
    },
  },
  clientInfo: { name: 'Weave Portal', version: '0.1.0' },
};

export const sessionIdFrom = (value: unknown) => {
  const sessionId = objectFrom(value).sessionId;
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Agent returned no ACP session ID.');
  return sessionId;
};

export const sessionLoadStateFrom = (value: unknown): Record<string, unknown> => {
  const record = objectFrom(value);
  return {
    ...(record.modes === undefined ? {} : { modes: record.modes }),
    ...(record.configOptions === undefined ? {} : { configOptions: record.configOptions }),
    ...(record._meta === undefined ? {} : { _meta: record._meta }),
  };
};

const supportsSessionResume = (initializeResult: unknown) => {
  const capabilities = objectFrom(objectFrom(initializeResult).agentCapabilities);
  return objectFrom(capabilities.sessionCapabilities).resume !== undefined;
};

export const supportsSessionLoad = (initializeResult: unknown) =>
  objectFrom(objectFrom(initializeResult).agentCapabilities).loadSession === true;

export const restoreProviderSession = async (
  process: AgentProcess,
  initializeResult: unknown,
  params: { sessionId: string; cwd: string; mcpServers: unknown[] },
) => {
  if (supportsSessionResume(initializeResult)) {
    try {
      return await process.request('session/resume', params);
    } catch {
      // Fall through to load when the provider advertises both operations.
    }
  }
  if (supportsSessionLoad(initializeResult)) return await process.request('session/load', params);
  throw new Error('CANNOT_RESUME');
};
