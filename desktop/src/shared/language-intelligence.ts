import type { EditorTarget } from './editor';

export type LspSessionInput = {
  target: EditorTarget;
  path: string;
  languageId?: string;
  serverId?: string;
};

export type LspSessionResult = {
  ok: true;
  sessionId: string;
  status: 'ready' | 'missing' | 'disabled' | 'unsupported' | 'error';
  serverId?: string;
  languageId?: string;
  documentUri?: string;
  rootUri?: string;
  rootPath?: string;
  command?: string;
  args?: string[];
  capabilities?: unknown;
  error?: string;
  token?: string;
  portalId?: string;
  wsUrl: string;
};
