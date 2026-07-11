export type ToolActivityPlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export type ToolActivityPlanStep = {
  id?: string;
  step: string;
  status: ToolActivityPlanStepStatus;
};

export type ToolActivityPlan = {
  title?: string;
  artifactPath?: string;
  status?: ToolActivityPlanStepStatus;
  plan: ToolActivityPlanStep[];
  completed: number;
  total: number;
  updatedAt: string;
  isBusy: boolean;
};

export type ToolActivityProposalItemStatus = 'pending' | 'approved' | 'changes_requested' | 'rejected' | 'applied' | 'stale';
export type ToolActivityProposalStatus = 'draft' | 'ready' | 'partially_approved' | 'approved' | 'changes_requested' | 'applied' | 'rejected' | 'stale';

export type ToolActivityProposalItem = {
  id: string;
  kind: string;
  status: ToolActivityProposalItemStatus;
  title: string;
  path?: string;
  additions: number;
  deletions: number;
  viewed: boolean;
  currentHash?: string;
  proposedHash?: string;
  comment?: string;
};

export type ToolActivityProposal = {
  id?: string;
  title?: string;
  path?: string;
  planPath?: string;
  status?: ToolActivityProposalStatus;
  summary?: string;
  items: ToolActivityProposalItem[];
  counts: Record<string, number>;
  updatedAt: string;
  contentHash?: string;
  isBusy: boolean;
};

type PlanPayload = {
  title?: string;
  artifactPath?: string;
  status?: ToolActivityPlanStepStatus;
  plan: ToolActivityPlanStep[];
  completed?: number;
  total?: number;
  updatedAt?: string;
};

export type ToolActivityCall = {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  rawStatus?: string;
};

export type ToolActivitySideEffect =
  | { type: 'renameThread'; title: string }
  | { type: 'updatePlan'; plan: ToolActivityPlan }
  | { type: 'proposal'; proposal: ToolActivityProposal };

export type ToolActivityFollowTarget = {
  path: string;
  line: number;
  toolCallId: string;
};

export const isEmptyObject = (value: unknown) =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

export const isDegradedToolCall = ({ toolName, args, result }: Pick<ToolActivityCall, 'toolName' | 'args' | 'result'>) =>
  (toolName === 'call' || toolName === 'tool') && isEmptyObject(args) && result === undefined;

const normalizeToolName = (toolName: string) =>
  toolName.startsWith('functions.') ? toolName.slice('functions.'.length) : toolName;

export const isRenameThreadTool = (toolName: string) => ['renameThreadTool', 'rename-thread'].includes(normalizeToolName(toolName));
export const isAskUserTool = (toolName: string) => normalizeToolName(toolName) === 'ask_user';
export const isUpdatePlanTool = (toolName: string) =>
  ['writePlanTool', 'write_plan', 'write-plan', 'updatePlanTool', 'update_plan', 'update-plan'].includes(normalizeToolName(toolName));
const proposalToolNames = [
  'proposal_start',
  'proposal_read',
  'proposal_write',
  'proposal_edit',
  'proposal_delete',
  'proposal_discard',
  'proposal_status',
  'proposal_finalize',
  'proposal_mark',
];
export const isProposalTool = (toolName: string) =>
  proposalToolNames.includes(normalizeToolName(toolName));

const fileScopedProposalToolNames = new Set([
  'proposal_read',
  'proposal_write',
  'proposal_edit',
  'proposal_delete',
  'proposal_discard',
]);

const isFileScopedProposalTool = (toolName: string) =>
  fileScopedProposalToolNames.has(normalizeToolName(toolName));

const leakedToolOutputToolNames = [
  'read',
  'write',
  'edit',
  'bash',
  'webSearch',
  'webExtract',
  'ask_user',
  'rename-thread',
  'renameThreadTool',
  'write_plan',
  'writePlanTool',
  'update_plan',
  'updatePlanTool',
  ...proposalToolNames,
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'git_branch',
  'git_switch',
  'git_worktree',
  'editor_context',
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
  'file_write',
  'file_mkdir',
  'file_move',
  'file_delete',
  'file_upload',
  'multi_tool_use.parallel',
];
const leakedToolOutputFields = [
  'ok',
  'path',
  'command',
  'query',
  'results',
  'renamed',
  'answered',
  'cancelled',
  'updated',
  'completed',
  'total',
  'contentChars',
  'contentHash',
  'exitCode',
  'result',
  'recipient_name',
  'branch',
  'head',
  'clean',
  'ahead',
  'behind',
];
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const leakedToolOutputToolPattern = leakedToolOutputToolNames.map(escapeRegExp).join('|');
const leakedToolOutputFieldPatternSource = leakedToolOutputFields.map(escapeRegExp).join('|');
const leakedToolOutputHeadingPattern = new RegExp(
  `^\\s*(${leakedToolOutputToolPattern}) result:\\s*\\n`,
);
const leakedToolOutputFunctionCallPattern = new RegExp(
  `^\\s*(?:functions\\.)?(?:${leakedToolOutputToolPattern})\\s*\\([\\s\\S]*\\)\\s*$`,
);
const leakedToolOutputFieldPattern = new RegExp(
  `(?:^|\\n)(${leakedToolOutputFieldPatternSource}):\\s`,
);
const leakedToolOutputInlineFieldPattern = new RegExp(
  `(?:^|\\s)(${leakedToolOutputFieldPatternSource}):\\s`,
);

const isPotentialLeakedToolOutputToolLine = (line: string) =>
  leakedToolOutputToolNames.some(toolName =>
    toolName.startsWith(line) || line === toolName || line.startsWith(`${toolName} `) || line.startsWith(`${toolName}:`)
  );

export const isLeakedToolOutputText = (text: string) => {
  if (text.startsWith('Compact tool result summary\n')) return true;
  if (leakedToolOutputFunctionCallPattern.test(text)) return true;

  const headingMatch = leakedToolOutputHeadingPattern.exec(text);
  if (!headingMatch) return false;
  if (leakedToolOutputFieldPattern.test(text)) return true;

  const body = text.slice(headingMatch[0].length);
  const firstNonEmptyLine = body.split(/\r?\n/).find(line => line.trim().length > 0)?.trimStart() ?? '';
  return isPotentialLeakedToolOutputToolLine(firstNonEmptyLine) &&
    leakedToolOutputInlineFieldPattern.test(firstNonEmptyLine);
};

const leakedProposalToolCallPattern = new RegExp(
  `^\\s*(?:functions\\.)?(?:${proposalToolNames.join('|')})\\s*\\([\\s\\S]*\\)\\s*$`,
);

export const isLeakedProposalToolCallText = (text: string) =>
  leakedProposalToolCallPattern.test(text);

const isPlanStepStatus = (value: unknown): value is ToolActivityPlanStepStatus =>
  value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'blocked';

const isProposalItemStatus = (value: unknown): value is ToolActivityProposalItemStatus =>
  value === 'pending' || value === 'approved' || value === 'changes_requested' || value === 'rejected'
  || value === 'applied' || value === 'stale';

const isProposalStatus = (value: unknown): value is ToolActivityProposalStatus =>
  value === 'draft' || value === 'ready' || value === 'partially_approved' || value === 'approved'
  || value === 'changes_requested' || value === 'applied' || value === 'rejected' || value === 'stale';

const getPlanPayload = (result: unknown, args: unknown): PlanPayload | null => {
  const source = result && typeof result === 'object' ? result : args;
  if (!source || typeof source !== 'object') return null;

  const record = source as Record<string, unknown>;
  const checklistPlan = Array.isArray(record.checklist) ? record.checklist as unknown[] : undefined;
  const legacyPlan = Array.isArray(record.plan) ? record.plan as unknown[] : undefined;
  const isChecklistPayload = Boolean(checklistPlan);
  const sourcePlan = checklistPlan ?? legacyPlan;
  if (!sourcePlan) return null;

  const plan = sourcePlan
    .map(item => {
      if (!item || typeof item !== 'object') return null;
      const itemRecord = item as Record<string, unknown>;
      const step = typeof itemRecord.step === 'string'
        ? itemRecord.step
        : typeof itemRecord.text === 'string'
          ? itemRecord.text
          : undefined;
      const status = isPlanStepStatus(itemRecord.status)
        ? itemRecord.status
        : isChecklistPayload
          ? 'pending'
          : undefined;
      if (typeof step !== 'string' || !status) return null;
      return {
        step,
        status,
        ...(typeof itemRecord.id === 'string' ? { id: itemRecord.id } : {}),
      };
    })
    .filter((item): item is ToolActivityPlanStep => item !== null);

  if (plan.length === 0) return null;

  return {
    plan,
    completed: typeof record.completed === 'number' ? record.completed : undefined,
    total: typeof record.total === 'number' ? record.total : undefined,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : undefined,
    ...(typeof record.title === 'string' ? { title: record.title } : {}),
    ...(typeof record.artifactPath === 'string'
      ? { artifactPath: record.artifactPath }
      : typeof record.path === 'string'
      ? { artifactPath: record.path }
      : {}),
    ...(isPlanStepStatus(record.status) ? { status: record.status } : {}),
  };
};

const toThreadPlan = (payload: PlanPayload, isBusy: boolean): ToolActivityPlan => ({
  title: payload.title,
  artifactPath: payload.artifactPath,
  status: payload.status,
  plan: payload.plan,
  completed: payload.completed ?? payload.plan.filter(item => item.status === 'completed').length,
  total: payload.total ?? payload.plan.length,
  updatedAt: payload.updatedAt ?? new Date().toISOString(),
  isBusy,
});

const getProposalPayload = (result: unknown, args: unknown): Omit<ToolActivityProposal, 'isBusy'> | null => {
  const source = result && typeof result === 'object' ? result : args;
  if (!source || typeof source !== 'object') return null;
  const record = source as Record<string, unknown>;
  const sourceItems = Array.isArray(record.items) ? record.items : undefined;
  if (!sourceItems) return null;
  const items = sourceItems
    .map(item => {
      if (!item || typeof item !== 'object') return null;
      const itemRecord = item as Record<string, unknown>;
      if (typeof itemRecord.id !== 'string' || !isProposalItemStatus(itemRecord.status)) return null;
      const path = typeof itemRecord.path === 'string' ? itemRecord.path : undefined;
      return {
        id: itemRecord.id,
        kind: typeof itemRecord.kind === 'string' ? itemRecord.kind : 'file_edit',
        status: itemRecord.status,
        title: typeof itemRecord.title === 'string' ? itemRecord.title : path ?? itemRecord.id,
        ...(path ? { path } : {}),
        additions: typeof itemRecord.additions === 'number' ? itemRecord.additions : 0,
        deletions: typeof itemRecord.deletions === 'number' ? itemRecord.deletions : 0,
        viewed: itemRecord.viewed === true,
        ...(typeof itemRecord.current_hash === 'string' ? { currentHash: itemRecord.current_hash } : {}),
        ...(typeof itemRecord.proposed_hash === 'string' ? { proposedHash: itemRecord.proposed_hash } : {}),
        ...(typeof itemRecord.comment === 'string' ? { comment: itemRecord.comment } : {}),
      };
    })
    .filter((item): item is ToolActivityProposalItem => item !== null);
  if (items.length === 0) return null;
  const countsRecord = record.counts && typeof record.counts === 'object' && !Array.isArray(record.counts)
    ? record.counts as Record<string, unknown>
    : {};
  const counts = Object.fromEntries(Object.entries(countsRecord).filter(([, count]) => typeof count === 'number')) as Record<string, number>;
  return {
    items,
    counts,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.title === 'string' ? { title: record.title } : {}),
    ...(typeof record.path === 'string' ? { path: record.path } : {}),
    ...(typeof record.planPath === 'string' ? { planPath: record.planPath } : {}),
    ...(isProposalStatus(record.status) ? { status: record.status } : {}),
    ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
    ...(typeof record.contentHash === 'string' ? { contentHash: record.contentHash } : {}),
  };
};

export const getToolChipDetail = (toolName: string, args: unknown) => {
  const record = args && typeof args === 'object' ? args as Record<string, unknown> : undefined;
  if (toolName === 'bash' && typeof record?.command === 'string') return record.command;
  if (['read', 'write', 'edit'].includes(toolName) && typeof record?.path === 'string') return record.path;
  if (isUpdatePlanTool(toolName)) {
    if (typeof record?.artifactPath === 'string') return record.artifactPath;
    if (typeof record?.planPath === 'string') return record.planPath;
    if (typeof record?.title === 'string') return record.title;
  }
  if (isProposalTool(toolName)) {
    if (isFileScopedProposalTool(toolName) && typeof record?.path === 'string') return record.path;
    if (typeof record?.proposalPath === 'string') return record.proposalPath;
    if (typeof record?.path === 'string') return record.path;
    if (typeof record?.title === 'string') return record.title;
  }
  return '';
};

const getProposalFilePath = (toolName: string, args: unknown, result: unknown) => {
  const argsRecord = args && typeof args === 'object' ? args as Record<string, unknown> : undefined;
  if (typeof argsRecord?.path === 'string') return argsRecord.path;
  if (normalizeToolName(toolName) !== 'proposal_read') return undefined;
  const resultRecord = result && typeof result === 'object' ? result as Record<string, unknown> : undefined;
  return typeof resultRecord?.path === 'string' ? resultRecord.path : undefined;
};

export const getToolResultText = (toolName: string, result: unknown, args?: unknown) => {
  if (result === undefined) return '';
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (typeof record.content === 'string') return record.content;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.stdout === 'string' || typeof record.stderr === 'string') {
      return [record.stdout, record.stderr].filter(item => typeof item === 'string' && item.trim()).join('\n');
    }
    if (toolName === 'write' && typeof record.bytes === 'number') return `Wrote ${record.bytes} bytes.`;
    if (toolName === 'edit' && typeof record.replacements === 'number') return `Applied ${record.replacements} replacement${record.replacements === 1 ? '' : 's'}.`;
    if (typeof record.diff === 'string' && record.diff.trim()) return record.diff;
    if (typeof record.error === 'string') return record.error;
    if (isUpdatePlanTool(toolName)) {
      if (typeof record.artifactPath === 'string') return `Plan linked: ${record.artifactPath}`;
      if (typeof record.path === 'string') return `Plan artifact updated: ${record.path}`;
      if (typeof record.title === 'string') return `Plan updated: ${record.title}`;
    }
    if (isFileScopedProposalTool(toolName)) {
      const path = getProposalFilePath(toolName, args, result);
      if (path) {
        if (normalizeToolName(toolName) === 'proposal_read') return `Proposal file read: ${path}`;
        if (normalizeToolName(toolName) === 'proposal_discard') {
          return record.discarded === 0
            ? `No proposal file item discarded: ${path}`
            : `Proposal file item discarded: ${path}`;
        }
        return `Proposal file item updated: ${path}`;
      }
    }
    if (isProposalTool(toolName) && typeof record.path === 'string') return `Proposal artifact updated: ${record.path}`;
  }
  return JSON.stringify(result, null, 2);
};

const dynamicToolNameFromType = (type: unknown) =>
  typeof type === 'string'
    && type.startsWith('tool-')
    && !['tool-call', 'tool-invocation', 'tool-result'].includes(type)
    ? type.slice('tool-'.length)
    : undefined;

export const isToolCallRecord = (part: unknown): part is Record<string, unknown> =>
  Boolean(
    part
      && typeof part === 'object'
      && (
        (part as { type?: unknown }).type === 'tool-call'
        || dynamicToolNameFromType((part as { type?: unknown }).type)
      ),
  );

export const getToolCallRawStatus = (part: Record<string, unknown>) => {
  const status = part.status && typeof part.status === 'object' ? part.status as Record<string, unknown> : undefined;
  if (typeof status?.type === 'string') return status.type;
  if (part.state === 'output-available') return 'complete';
  if (part.state === 'output-error') return 'error';
  if (typeof part.state === 'string' && part.state.startsWith('input-')) return 'running';
  return undefined;
};

export const toToolActivityCall = (part: unknown): ToolActivityCall | null => {
  if (!isToolCallRecord(part)) return null;
  const rawToolName = typeof part.toolName === 'string' ? part.toolName : dynamicToolNameFromType(part.type);
  const toolName = typeof rawToolName === 'string' ? normalizeToolName(rawToolName) : undefined;
  if (typeof part.toolCallId !== 'string' || typeof toolName !== 'string') return null;

  return {
    toolCallId: part.toolCallId,
    toolName,
    args: part.args ?? part.input,
    result: part.result ?? part.output ?? part.errorText,
    isError: Boolean(part.isError) || part.state === 'output-error',
    rawStatus: getToolCallRawStatus(part),
  };
};

export const getToolActivityStatus = (call: ToolActivityCall) => {
  if (call.result !== undefined) return call.isError ? 'error' : 'complete';
  if (call.rawStatus === 'incomplete') return 'running';
  return call.rawStatus ?? 'running';
};

export const isHiddenToolCall = (call: ToolActivityCall) => isRenameThreadTool(call.toolName) || isAskUserTool(call.toolName);

export const getArgsRecord = (args: unknown) => args && typeof args === 'object' ? args as Record<string, unknown> : {};

const getFirstUnifiedDiffNewLine = (diff: unknown) => {
  if (typeof diff !== 'string') return undefined;
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/m.exec(diff);
  if (!match) return undefined;
  const line = Number(match[1]);
  return Number.isInteger(line) && line > 0 ? line : undefined;
};

export const getToolActivityFollowTarget = (call: ToolActivityCall): ToolActivityFollowTarget | null => {
  if (call.isError || getToolActivityStatus(call) !== 'complete') return null;
  if (call.toolName !== 'write' && call.toolName !== 'edit') return null;

  const args = getArgsRecord(call.args);
  const path = typeof args.path === 'string' && args.path.trim()
    ? args.path.trim()
    : undefined;
  if (!path) return null;

  const result = call.result && typeof call.result === 'object' ? call.result as Record<string, unknown> : {};
  if (result.ok === false) return null;
  return {
    path,
    line: call.toolName === 'edit' ? getFirstUnifiedDiffNewLine(result.diff) ?? 1 : 1,
    toolCallId: call.toolCallId,
  };
};

const isSearchCommand = (command: string) => /(^|\s|\|)\s*(rg|grep|ag|fd)\b/.test(command.trim());
const isListCommand = (command: string) => /^(ls|find|tree)\b/.test(command.trim());

const pluralize = (count: number, singular: string, plural = `${singular}s`) =>
  `${count} ${count === 1 ? singular : plural}`;

const joinSummaryPieces = (pieces: string[]) => pieces.join(', ');

const lowerFirst = (value: string) => value ? `${value[0].toLowerCase()}${value.slice(1)}` : value;

export const summarizeToolActivity = (calls: ToolActivityCall[]) => {
  const readPaths = new Set<string>();
  let searches = 0;
  let lists = 0;
  let commands = 0;
  let edits = 0;
  let writes = 0;
  let pages = 0;
  let otherTools = 0;

  for (const call of calls) {
    const args = getArgsRecord(call.args);
    if (call.toolName === 'read') {
      const path = typeof args.path === 'string' ? args.path : call.toolCallId;
      readPaths.add(path);
      continue;
    }

    if (call.toolName === 'webSearch') {
      searches += 1;
      continue;
    }

    if (call.toolName === 'webExtract') {
      pages += Array.isArray(args.urls) ? Math.max(args.urls.length, 1) : 1;
      continue;
    }

    if (call.toolName === 'bash') {
      const command = typeof args.command === 'string' ? args.command : '';
      if (isSearchCommand(command)) searches += 1;
      else if (isListCommand(command)) lists += 1;
      else commands += 1;
      continue;
    }

    if (call.toolName === 'edit') {
      edits += 1;
      continue;
    }

    if (call.toolName === 'write') {
      writes += 1;
      continue;
    }

    otherTools += 1;
  }

  const chunks: string[] = [];
  const explored = [
    readPaths.size ? pluralize(readPaths.size, 'file') : '',
    searches ? pluralize(searches, 'search', 'searches') : '',
    lists ? pluralize(lists, 'list') : '',
    pages ? pluralize(pages, 'page') : '',
  ].filter(Boolean);

  if (explored.length) chunks.push(`Explored ${joinSummaryPieces(explored)}`);
  if (commands) chunks.push(`Ran ${pluralize(commands, 'command')}`);
  if (edits) chunks.push(`Edited ${pluralize(edits, 'file')}`);
  if (writes) chunks.push(`Wrote ${pluralize(writes, 'file')}`);
  if (otherTools) chunks.push(`Used ${pluralize(otherTools, 'tool')}`);

  return chunks.length
    ? chunks.map((chunk, index) => index === 0 ? chunk : lowerFirst(chunk)).join(', ')
    : `Used ${pluralize(calls.length, 'tool')}`;
};

export const shouldRenderToolActivityChildren = (showToolCalls: boolean, visibleCallCount: number, isCollapsed: boolean) =>
  showToolCalls && visibleCallCount > 0 && !isCollapsed;

export const getToolActivitySideEffect = (call: ToolActivityCall): ToolActivitySideEffect | null => {
  if (isRenameThreadTool(call.toolName)) {
    const args = call.args as { title?: unknown } | undefined;
    const result = call.result as { renamed?: unknown; title?: unknown } | undefined;
    const title = typeof args?.title === 'string' ? args.title : typeof result?.title === 'string' ? result.title : undefined;
    return title ? { type: 'renameThread', title } : null;
  }

  if (isUpdatePlanTool(call.toolName)) {
    const payload = getPlanPayload(call.result, call.args);
    return payload ? { type: 'updatePlan', plan: toThreadPlan(payload, getToolActivityStatus(call) === 'running') } : null;
  }

  if (isProposalTool(call.toolName)) {
    const payload = getProposalPayload(call.result, call.args);
    return payload ? { type: 'proposal', proposal: { ...payload, isBusy: getToolActivityStatus(call) === 'running' } } : null;
  }

  return null;
};
