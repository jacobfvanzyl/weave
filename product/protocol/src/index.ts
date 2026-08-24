export const PORTAL_PROTOCOL_VERSION = 1 as const;
export const PORTAL_RPC_PATH = '/rpc' as const;
export const PORTAL_ACP_PATH = '/acp' as const;
export const PORTAL_TOKEN_PROTOCOL_PREFIX = 'weave-portal-token.' as const;

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

export type PortalRpcContracts = {
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

export type PortalRpcMethod = keyof PortalRpcContracts;
export const PORTAL_RPC_METHODS = [
  'portal.capabilities',
  'workspace.list',
  'agent.list',
  'thread.list',
  'thread.create',
  'thread.attach',
] as const satisfies readonly PortalRpcMethod[];
export type PortalRpcParams<Method extends PortalRpcMethod> = PortalRpcContracts[Method]['params'];
export type PortalRpcResult<Method extends PortalRpcMethod> = PortalRpcContracts[Method]['result'];

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
  const result = object(value, `${method} result`);
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
  }
};
