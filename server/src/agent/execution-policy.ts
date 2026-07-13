export type ExecutionProfile = 'observe' | 'workspace' | 'host';

export type ToolExecutionDecision = 'allow' | 'ask' | 'deny';

export type ToolExecutionCall = {
  profile: ExecutionProfile;
  toolName: string;
  input?: unknown;
};

export interface ToolExecutionPolicy {
  decide(call: ToolExecutionCall): ToolExecutionDecision;
}

export const executionProfileRequestContextKey = 'weave.executionProfile';
export const rememberedToolApprovalsRequestContextKey = 'weave.rememberedToolApprovals';

const readOnlyTools = new Set([
  'ask_user',
  'view_attachment',
  'webSearch',
  'webExtract',
  'read',
  'editor_context',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'code_intel_capabilities',
  'code_diagnostics',
  'code_hover',
  'code_definition',
  'code_references',
  'code_symbols',
  'workspace_symbols',
  'code_actions',
  'code_action_preview',
  'rename_preview',
  'format_preview',
  'file_index',
  'file_read',
]);

const hostApprovalTools = new Set([
  'write',
  'edit',
  'bash',
  'exec_start',
  'exec_write',
  'exec_stop',
  'git_switch',
  'git_worktree',
  'file_write',
  'file_mkdir',
  'file_move',
  'file_delete',
  'file_upload',
]);

export const normalizeExecutionProfile = (value: unknown): ExecutionProfile =>
  value === 'observe' || value === 'host' ? value : 'workspace';

export const getExecutionProfile = (requestContext: any): ExecutionProfile =>
  normalizeExecutionProfile(
    requestContext?.get?.(executionProfileRequestContextKey) ??
      requestContext?.[executionProfileRequestContextKey] ??
      requestContext?.executionProfile,
  );

export const putExecutionProfile = (requestContext: any, profile: ExecutionProfile) => {
  requestContext?.set?.(executionProfileRequestContextKey, profile);
  if (requestContext && typeof requestContext === 'object' && typeof requestContext.set !== 'function') {
    requestContext[executionProfileRequestContextKey] = profile;
  }
};

export class DefaultToolExecutionPolicy implements ToolExecutionPolicy {
  decide({ profile, toolName, input }: ToolExecutionCall): ToolExecutionDecision {
    if (profile === 'observe') return readOnlyTools.has(toolName) ? 'allow' : 'deny';
    if (profile === 'host' && hostApprovalTools.has(toolName)) return 'ask';
    const command = input && typeof input === 'object' && typeof (input as Record<string, unknown>).command === 'string'
      ? (input as Record<string, unknown>).command as string
      : '';
    if (
      profile === 'workspace' && (toolName === 'bash' || toolName === 'exec_start') &&
      /(^|[;&|]\s*)git\s+(?:reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--|restore\s+(?:--source\s+\S+\s+)?(?:--worktree\s+)?\.)\b/i
        .test(command)
    ) return 'ask';
    return 'allow';
  }
}

export const toolExecutionPolicy = new DefaultToolExecutionPolicy();

export const toolDecision = (toolName: string, requestContext: any, input?: unknown) =>
  toolExecutionPolicy.decide({ profile: getExecutionProfile(requestContext), toolName, input });

export const toolNeedsApproval = (toolName: string, requestContext: any, input?: unknown) =>
  !getRememberedToolApprovals(requestContext).has(toolName) && toolDecision(toolName, requestContext, input) === 'ask';

export const toolAllowed = (toolName: string, requestContext: any) => toolDecision(toolName, requestContext) !== 'deny';

export const getRememberedToolApprovals = (requestContext: any) => {
  const value = requestContext?.get?.(rememberedToolApprovalsRequestContextKey) ??
    requestContext?.[rememberedToolApprovalsRequestContextKey];
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
};

export const rememberToolApproval = (requestContext: any, toolName: string) => {
  const approvals = [...getRememberedToolApprovals(requestContext), toolName];
  requestContext?.set?.(rememberedToolApprovalsRequestContextKey, approvals);
  if (requestContext && typeof requestContext === 'object' && typeof requestContext.set !== 'function') {
    requestContext[rememberedToolApprovalsRequestContextKey] = approvals;
  }
};
