export const PORTAL_PROTOCOL_VERSION = 1 as const;
export const PORTAL_RPC_PATH = '/rpc' as const;
export const PORTAL_ACP_PATH = '/acp' as const;
export const PORTAL_TOKEN_PROTOCOL_PREFIX = 'weave-portal-token.' as const;
export const WEAVE_ACP_META_NAMESPACE = 'weave.dev' as const;
export const WEAVE_ACP_THREAD_EVENTS_LOAD_META = 'weave.dev/threadEvents' as const;
export const WEAVE_ACP_THREAD_EVENT_META = 'weave.dev/threadEvent' as const;
export const WEAVE_ACP_THREAD_EVENTS_ACK_METHOD = '_weave.dev/thread_events/ack' as const;
export const WEAVE_ACP_THREAD_EVENTS_SYNC_METHOD = '_weave.dev/thread_events/sync' as const;
export const WEAVE_ACP_RUNTIME_STATE_METHOD = '_weave.dev/runtime/state' as const;

export {
  parseWorkspaceFileErrorData,
  parseWorkspaceFileRpcParams,
  parseWorkspaceFileRpcResult,
  parseWorkspaceFileWatchNotification,
  WORKSPACE_FILE_ERROR_CODES,
  WORKSPACE_FILE_RPC_METHODS,
  WORKSPACE_FILE_WATCH_EVENT_METHOD,
} from './workspace-files.ts';
export type {
  WorkspaceFileEntry,
  WorkspaceFileErrorCode,
  WorkspaceFileErrorData,
  WorkspaceFileMetadata,
  WorkspaceFileRpcContracts,
  WorkspaceFileRpcMethod,
  WorkspaceFileSearchMatch,
  WorkspaceFileWatchEvent,
  WorkspaceFileWatchNotification,
} from './workspace-files.ts';
import {
  parseWorkspaceFileRpcParams,
  parseWorkspaceFileRpcResult,
  WORKSPACE_FILE_RPC_METHODS,
  type WorkspaceFileRpcContracts,
  type WorkspaceFileRpcMethod,
} from './workspace-files.ts';

export type WorkspaceSummary = { workspaceId: string; name: string };
export type AgentSummary = { agentId: string; name: string };
export type ThreadSummary = {
  threadId: string;
  agentId: string;
  workspaceId: string;
  acpSessionId: string;
  title?: string;
  status: 'active' | 'closed';
  createdAt: string;
  updatedAt: string;
};

type BasePortalRpcContracts = {
  'portal.capabilities': {
    params: Record<string, never>;
    result: { protocolVersion: typeof PORTAL_PROTOCOL_VERSION; capabilities: string[] };
  };
  'workspace.list': { params: Record<string, never>; result: { workspaces: WorkspaceSummary[] } };
  'agent.list': { params: Record<string, never>; result: { agents: AgentSummary[] } };
  'thread.list': { params: Record<string, never>; result: { threads: ThreadSummary[] } };
  'thread.create': {
    params: { workspaceId: string; agentId: string; title?: string };
    result: { thread: ThreadSummary };
  };
  'thread.attach': {
    params: { threadId: string };
    result: {
      thread: ThreadSummary;
      connection: { path: typeof PORTAL_ACP_PATH; threadId: string; cwd: string };
    };
  };
};

export type PortalRpcContracts = BasePortalRpcContracts & WorkspaceFileRpcContracts;

export type PortalRpcMethod = keyof PortalRpcContracts;
export const PORTAL_RPC_METHODS = [
  'portal.capabilities',
  'workspace.list',
  'agent.list',
  'thread.list',
  'thread.create',
  'thread.attach',
  ...WORKSPACE_FILE_RPC_METHODS,
] as const satisfies readonly PortalRpcMethod[];
export type PortalRpcParams<Method extends PortalRpcMethod> = PortalRpcContracts[Method]['params'];
export type PortalRpcResult<Method extends PortalRpcMethod> = PortalRpcContracts[Method]['result'];

export const parsePortalRpcParams = <Method extends PortalRpcMethod>(
  method: Method,
  value: unknown,
): PortalRpcParams<Method> => {
  if (WORKSPACE_FILE_RPC_METHODS.includes(method as WorkspaceFileRpcMethod)) {
    return parseWorkspaceFileRpcParams(method as WorkspaceFileRpcMethod, value) as PortalRpcParams<Method>;
  }
  const params = object(value, `${String(method)} params`);
  switch (method) {
    case 'portal.capabilities':
    case 'workspace.list':
    case 'agent.list':
    case 'thread.list':
      return {} as PortalRpcParams<Method>;
    case 'thread.create':
      return {
        workspaceId: string(params.workspaceId, 'workspaceId'),
        agentId: string(params.agentId, 'agentId'),
        ...(params.title === undefined ? {} : { title: string(params.title, 'title') }),
      } as PortalRpcParams<Method>;
    case 'thread.attach':
      return { threadId: string(params.threadId, 'threadId') } as PortalRpcParams<Method>;
    default:
      throw new Error(`Unknown Portal method: ${String(method)}`);
  }
};

const object = (value: unknown, context: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context} must be an object.`);
  return value as Record<string, unknown>;
};

const string = (value: unknown, context: string) => {
  if (typeof value !== 'string' || !value) throw new Error(`${context} must be a non-empty string.`);
  return value;
};

const stringArray = (value: unknown, context: string) => {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array.`);
  return value.map((item, index) => string(item, `${context}[${index}]`));
};

const workspace = (value: unknown): WorkspaceSummary => {
  const record = object(value, 'workspace');
  return {
    workspaceId: string(record.workspaceId, 'workspace.workspaceId'),
    name: string(record.name, 'workspace.name'),
  };
};

const agent = (value: unknown): AgentSummary => {
  const record = object(value, 'agent');
  return { agentId: string(record.agentId, 'agent.agentId'), name: string(record.name, 'agent.name') };
};

const thread = (value: unknown): ThreadSummary => {
  const record = object(value, 'thread');
  const status = string(record.status, 'thread.status');
  if (status !== 'active' && status !== 'closed') throw new Error('thread.status is invalid.');
  return {
    threadId: string(record.threadId, 'thread.threadId'),
    agentId: string(record.agentId, 'thread.agentId'),
    workspaceId: string(record.workspaceId, 'thread.workspaceId'),
    acpSessionId: string(record.acpSessionId, 'thread.acpSessionId'),
    ...(record.title === undefined ? {} : { title: string(record.title, 'thread.title') }),
    status,
    createdAt: string(record.createdAt, 'thread.createdAt'),
    updatedAt: string(record.updatedAt, 'thread.updatedAt'),
  };
};

export const parsePortalRpcResult = <Method extends PortalRpcMethod>(
  method: Method,
  value: unknown,
): PortalRpcResult<Method> => {
  if (WORKSPACE_FILE_RPC_METHODS.includes(method as WorkspaceFileRpcMethod)) {
    return parseWorkspaceFileRpcResult(method as WorkspaceFileRpcMethod, value) as PortalRpcResult<Method>;
  }
  const result = object(value, `${String(method)} result`);
  switch (method) {
    case 'portal.capabilities':
      if (result.protocolVersion !== PORTAL_PROTOCOL_VERSION) {
        throw new Error('Portal protocol version is unsupported.');
      }
      return {
        protocolVersion: PORTAL_PROTOCOL_VERSION,
        capabilities: stringArray(result.capabilities, 'capabilities'),
      } as PortalRpcResult<Method>;
    case 'workspace.list':
      if (!Array.isArray(result.workspaces)) throw new Error('workspaces must be an array.');
      return { workspaces: result.workspaces.map(workspace) } as PortalRpcResult<Method>;
    case 'agent.list':
      if (!Array.isArray(result.agents)) throw new Error('agents must be an array.');
      return { agents: result.agents.map(agent) } as PortalRpcResult<Method>;
    case 'thread.list':
      if (!Array.isArray(result.threads)) throw new Error('threads must be an array.');
      return { threads: result.threads.map(thread) } as PortalRpcResult<Method>;
    case 'thread.create':
      return { thread: thread(result.thread) } as PortalRpcResult<Method>;
    case 'thread.attach': {
      const connection = object(result.connection, 'connection');
      if (connection.path !== PORTAL_ACP_PATH) throw new Error('connection.path is invalid.');
      return {
        thread: thread(result.thread),
        connection: {
          path: PORTAL_ACP_PATH,
          threadId: string(connection.threadId, 'connection.threadId'),
          cwd: string(connection.cwd, 'connection.cwd'),
        },
      } as PortalRpcResult<Method>;
    }
    default:
      throw new Error(`Unknown Portal method: ${String(method)}`);
  }
};
