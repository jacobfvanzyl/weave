import { parseWorkspaceComposition, type WorkspaceComposition } from './composition.ts';

export const WORKSPACE_LIFECYCLE_RPC_METHODS = ['workspace.close.preview', 'workspace.close'] as const;
export type WorkspaceLifecycleRpcMethod = typeof WORKSPACE_LIFECYCLE_RPC_METHODS[number];
export type WorkspaceClosePlan = {
  workspaceId: string;
  name: string;
  token: string;
  terminals: { terminalId: string; title: string; dirty: boolean }[];
  threads: { threadId: string; title: string; dirty: boolean }[];
};
export type WorkspaceLifecycleRpcContracts = {
  'workspace.close.preview': { params: { hostId: string; workspaceId: string }; result: { plan: WorkspaceClosePlan } };
  'workspace.close': { params: { hostId: string; workspaceId: string; token: string; confirmed: boolean }; result: { composition: WorkspaceComposition } };
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workspace close request.');
  return value as Record<string, unknown>;
};
const text = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || value.includes('\0')) throw new Error('Invalid workspace close identity.');
  return value;
};
const flag = (value: unknown) => {
  if (typeof value !== 'boolean') throw new Error('Invalid workspace close confirmation.');
  return value;
};
export function parseWorkspaceLifecycleParams<M extends WorkspaceLifecycleRpcMethod>(method: M, value: unknown): WorkspaceLifecycleRpcContracts[M]['params'] {
  const input = record(value);
  return { hostId: text(input.hostId), workspaceId: text(input.workspaceId), ...(method === 'workspace.close' ? { token: text(input.token), confirmed: flag(input.confirmed) } : {}) } as WorkspaceLifecycleRpcContracts[M]['params'];
}
export function parseWorkspaceLifecycleResult<M extends WorkspaceLifecycleRpcMethod>(method: M, value: unknown): WorkspaceLifecycleRpcContracts[M]['result'] {
  const input = record(value);
  if (method === 'workspace.close') return { composition: parseWorkspaceComposition(input.composition) } as WorkspaceLifecycleRpcContracts[M]['result'];
  const plan = record(input.plan);
  if (!Array.isArray(plan.terminals) || !Array.isArray(plan.threads)) throw new Error('Invalid workspace close consequences.');
  return { plan: { workspaceId: text(plan.workspaceId), name: text(plan.name), token: text(plan.token),
    terminals: plan.terminals.map((value) => { const item = record(value); return { terminalId: text(item.terminalId), title: text(item.title), dirty: flag(item.dirty) }; }),
    threads: plan.threads.map((value) => { const item = record(value); return { threadId: text(item.threadId), title: text(item.title), dirty: flag(item.dirty) }; }),
  } } as WorkspaceLifecycleRpcContracts[M]['result'];
}
