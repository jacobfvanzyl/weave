export type ToolActivityPlanStepStatus = 'pending' | 'in_progress' | 'completed';

export type ToolActivityPlanStep = {
  step: string;
  status: ToolActivityPlanStepStatus;
};

export type ToolActivityPlan = {
  plan: ToolActivityPlanStep[];
  completed: number;
  total: number;
  updatedAt: string;
  isBusy: boolean;
};

type PlanPayload = {
  plan: ToolActivityPlanStep[];
  completed?: number;
  total?: number;
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
  | { type: 'updatePlan'; plan: ToolActivityPlan };

export const isEmptyObject = (value: unknown) =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

export const isDegradedToolCall = ({ toolName, args, result }: Pick<ToolActivityCall, 'toolName' | 'args' | 'result'>) =>
  (toolName === 'call' || toolName === 'tool') && isEmptyObject(args) && result === undefined;

export const isRenameThreadTool = (toolName: string) => ['renameThreadTool', 'rename-thread'].includes(toolName);
export const isUpdatePlanTool = (toolName: string) => ['updatePlanTool', 'update_plan', 'update-plan'].includes(toolName);

const isPlanStepStatus = (value: unknown): value is ToolActivityPlanStepStatus =>
  value === 'pending' || value === 'in_progress' || value === 'completed';

const getPlanPayload = (result: unknown, args: unknown): PlanPayload | null => {
  const source = result && typeof result === 'object' ? result : args;
  if (!source || typeof source !== 'object') return null;

  const record = source as Record<string, unknown>;
  if (!Array.isArray(record.plan)) return null;

  const plan = record.plan
    .map(item => {
      if (!item || typeof item !== 'object') return null;
      const step = (item as Record<string, unknown>).step;
      const status = (item as Record<string, unknown>).status;
      if (typeof step !== 'string' || !isPlanStepStatus(status)) return null;
      return { step, status };
    })
    .filter((item): item is ToolActivityPlanStep => item !== null);

  if (plan.length === 0) return null;

  return {
    plan,
    completed: typeof record.completed === 'number' ? record.completed : undefined,
    total: typeof record.total === 'number' ? record.total : undefined,
  };
};

const toThreadPlan = (payload: PlanPayload, isBusy: boolean): ToolActivityPlan => ({
  plan: payload.plan,
  completed: payload.completed ?? payload.plan.filter(item => item.status === 'completed').length,
  total: payload.total ?? payload.plan.length,
  updatedAt: new Date().toISOString(),
  isBusy,
});

export const getToolChipDetail = (toolName: string, args: unknown) => {
  const record = args && typeof args === 'object' ? args as Record<string, unknown> : undefined;
  if (toolName === 'bash' && typeof record?.command === 'string') return record.command;
  if (['read', 'write', 'edit'].includes(toolName) && typeof record?.path === 'string') return record.path;
  return '';
};

export const getToolResultText = (toolName: string, result: unknown) => {
  if (result === undefined) return '';
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (typeof record.content === 'string') return record.content;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.stdout === 'string' || typeof record.stderr === 'string') {
      return [record.stdout, record.stderr].filter(item => typeof item === 'string' && item.trim()).join('\n');
    }
    if (typeof record.diff === 'string' && record.diff.trim()) return record.diff;
    if (toolName === 'write' && typeof record.bytes === 'number') return `Wrote ${record.bytes} bytes.`;
    if (toolName === 'edit' && typeof record.replacements === 'number') return `Applied ${record.replacements} replacement${record.replacements === 1 ? '' : 's'}.`;
    if (typeof record.error === 'string') return record.error;
  }
  return JSON.stringify(result, null, 2);
};

export const isToolCallRecord = (part: unknown): part is Record<string, unknown> =>
  Boolean(part && typeof part === 'object' && (part as { type?: unknown }).type === 'tool-call');

export const getToolCallRawStatus = (part: Record<string, unknown>) => {
  const status = part.status && typeof part.status === 'object' ? part.status as Record<string, unknown> : undefined;
  return typeof status?.type === 'string' ? status.type : undefined;
};

export const toToolActivityCall = (part: unknown): ToolActivityCall | null => {
  if (!isToolCallRecord(part)) return null;
  if (typeof part.toolCallId !== 'string' || typeof part.toolName !== 'string') return null;

  return {
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    args: part.args,
    result: part.result,
    isError: Boolean(part.isError),
    rawStatus: getToolCallRawStatus(part),
  };
};

export const getToolActivityStatus = (call: ToolActivityCall) => {
  if (call.result !== undefined) return call.isError ? 'error' : 'complete';
  if (call.rawStatus === 'incomplete') return 'running';
  return call.rawStatus ?? 'running';
};

export const isHiddenToolCall = (call: ToolActivityCall) => isRenameThreadTool(call.toolName) || isUpdatePlanTool(call.toolName);

export const getArgsRecord = (args: unknown) => args && typeof args === 'object' ? args as Record<string, unknown> : {};

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

  return null;
};
