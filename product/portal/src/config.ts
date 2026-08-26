import { isAbsolute, resolve } from 'jsr:@std/path@1.1.2';

export type WorkspaceDefinition = {
  workspaceId: string;
  name: string;
  path: string;
};
export type AgentDefinition = {
  agentId: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
};
export type PortalConfig = {
  listen: { hostname: string; port: number };
  displayName: string;
  publicUrl?: string;
  tls?: { certificateFile: string; privateKeyFile: string };
  allowedOrigins: string[];
  stateDirectory: string;
  threadEventRetentionLimit?: number;
  workspaces: WorkspaceDefinition[];
  agents: AgentDefinition[];
};

const object = (value: unknown, context: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const text = (value: unknown, context: string) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${context} must be a non-empty string.`);
  }
  return value.trim();
};

const stringList = (value: unknown, context: string) => {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array.`);
  return value.map((item, index) => text(item, `${context}[${index}]`));
};

const unique = (values: string[], context: string) => {
  if (new Set(values).size !== values.length) {
    throw new Error(`${context} values must be unique.`);
  }
};

export const parsePortalConfig = (value: unknown): PortalConfig => {
  const root = object(value, 'Portal config');
  const listen = object(root.listen, 'listen');
  const hostname = text(listen.hostname, 'listen.hostname');
  const port = listen.port;
  if (!Number.isInteger(port) || Number(port) < 0 || Number(port) > 65_535) {
    throw new Error('listen.port is invalid.');
  }

  const displayName = text(root.displayName ?? hostname, 'displayName');
  let publicUrl: string | undefined;
  if (root.publicUrl !== undefined) {
    const parsed = new URL(text(root.publicUrl, 'publicUrl'));
    if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
      throw new Error('publicUrl must use ws or wss.');
    }
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    publicUrl = parsed.toString().replace(/\/$/, '');
  }

  let tls: PortalConfig['tls'];
  if (root.tls !== undefined) {
    const input = object(root.tls, 'tls');
    const certificateFile = text(input.certificateFile, 'tls.certificateFile');
    const privateKeyFile = text(input.privateKeyFile, 'tls.privateKeyFile');
    if (!isAbsolute(certificateFile) || !isAbsolute(privateKeyFile)) {
      throw new Error(
        'TLS certificate and private key paths must be absolute.',
      );
    }
    tls = {
      certificateFile: resolve(certificateFile),
      privateKeyFile: resolve(privateKeyFile),
    };
  }

  const loopback = hostname === '127.0.0.1' || hostname === '::1' ||
    hostname === 'localhost';
  if (!loopback && !tls) {
    throw new Error('A non-loopback Portal listener requires TLS.');
  }
  if (!loopback && publicUrl && !publicUrl.startsWith('wss://')) {
    throw new Error('A non-loopback Portal publicUrl must use wss.');
  }
  if (!loopback && root.allowedOrigins === undefined) {
    throw new Error(
      'A non-loopback Portal listener requires an explicit allowedOrigins list.',
    );
  }

  const stateDirectory = text(root.stateDirectory, 'stateDirectory');
  if (!isAbsolute(stateDirectory)) {
    throw new Error('stateDirectory must be absolute.');
  }
  const threadEventRetentionLimit = root.threadEventRetentionLimit ?? 10_000;
  if (
    !Number.isInteger(threadEventRetentionLimit) ||
    Number(threadEventRetentionLimit) < 1
  ) {
    throw new Error('threadEventRetentionLimit must be a positive integer.');
  }

  if (!Array.isArray(root.workspaces) || !root.workspaces.length) {
    throw new Error('workspaces must contain at least one entry.');
  }
  const workspaces = root.workspaces.map((value, index) => {
    const workspace = object(value, `workspaces[${index}]`);
    const path = text(workspace.path, `workspaces[${index}].path`);
    if (!isAbsolute(path)) {
      throw new Error(`workspaces[${index}].path must be absolute.`);
    }
    return {
      workspaceId: text(
        workspace.workspaceId,
        `workspaces[${index}].workspaceId`,
      ),
      name: text(workspace.name, `workspaces[${index}].name`),
      path: resolve(path),
    };
  });

  if (!Array.isArray(root.agents) || !root.agents.length) {
    throw new Error('agents must contain at least one entry.');
  }
  const agents = root.agents.map((value, index) => {
    const agent = object(value, `agents[${index}]`);
    const rawEnv = agent.env === undefined ? {} : object(agent.env, `agents[${index}].env`);
    return {
      agentId: text(agent.agentId, `agents[${index}].agentId`),
      name: text(agent.name, `agents[${index}].name`),
      command: text(agent.command, `agents[${index}].command`),
      args: agent.args === undefined ? [] : stringList(agent.args, `agents[${index}].args`),
      env: Object.fromEntries(
        Object.entries(rawEnv).map((
          [name, value],
        ) => [name, text(value, `agents[${index}].env.${name}`)]),
      ),
    };
  });

  unique(workspaces.map((workspace) => workspace.workspaceId), 'workspaceId');
  unique(agents.map((agent) => agent.agentId), 'agentId');
  return {
    listen: { hostname, port: Number(port) },
    displayName,
    ...(publicUrl ? { publicUrl } : {}),
    ...(tls ? { tls } : {}),
    allowedOrigins: root.allowedOrigins === undefined ? [] : stringList(root.allowedOrigins, 'allowedOrigins'),
    stateDirectory: resolve(stateDirectory),
    threadEventRetentionLimit: Number(threadEventRetentionLimit),
    workspaces,
    agents,
  };
};

export const loadPortalConfig = async (path: string) => parsePortalConfig(JSON.parse(await Deno.readTextFile(path)));
