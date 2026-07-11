import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { productProjectRepository } from '../../../products/project-repository';
import { portalToolScope } from '../../../services/providers/portal-provider';
import { callerForOwner, ServiceError } from '../../../services/types';
import { toolService } from '../../../services/tool-runtime';
import { createServicePortalNotesVaultBackend } from '../../../modules/notes/storage/portal-backend';
import { getNotesVaultBackend } from '../../../modules/notes/storage/registry';
import {
  type NotesVaultResolverDependencies,
  resolveNotesVaultForThreadContext,
} from '../../../modules/notes/storage/resolver';
import { toolDescription, toolInputDescription } from './instructions';
import { formatToolModelOutput, getCodeToolModelOutputMaxChars, hashText } from './model-output';

export const offlineMessage =
  'This thread is not bound to an active Workspace. Connect a Portal or choose a Project with an online Portal to use local tools.';

const projectThreadId = (projectId: string) => `__project__${projectId}`;

export const getThreadBinding = async (context: any) => {
  const threadId = context.agent?.threadId;
  const contextResourceId = context.agent?.resourceId;
  if (!threadId) throw new Error(offlineMessage);

  const agent = await context.mastra?.getAgent('mageHandAgent');
  const memory = await agent?.getMemory();
  const thread = await memory?.getThreadById({ threadId });
  const resourceId = typeof contextResourceId === 'string' && contextResourceId
    ? contextResourceId
    : thread?.resourceId;
  const metadata = thread?.metadata as Record<string, unknown> | undefined;

  if (!thread || !resourceId || thread.resourceId !== resourceId) throw new Error(offlineMessage);
  if (
    metadata?.mode !== 'project' || typeof metadata.projectId !== 'string' || typeof metadata.workspaceId !== 'string'
  ) {
    throw new Error(offlineMessage);
  }

  let projectMetadata = await productProjectRepository.get(resourceId, metadata.projectId) as
    | Record<string, any>
    | undefined;
  if (!projectMetadata) {
    const projectThread = await memory?.getThreadById({ threadId: projectThreadId(metadata.projectId) }).catch(() =>
      undefined
    );
    const legacyMetadata = projectThread?.metadata as Record<string, any> | undefined;
    if (legacyMetadata?.kind === 'project') {
      projectMetadata = legacyMetadata;
      await productProjectRepository.save(legacyMetadata as any).catch(() => undefined);
    }
  }
  const workspace = Array.isArray(projectMetadata?.workspaces)
    ? projectMetadata.workspaces.find((item: any) => item?.id === metadata.workspaceId)
    : undefined;
  const portalId = typeof workspace?.portalId === 'string'
    ? workspace.portalId
    : typeof projectMetadata?.portalId === 'string'
    ? projectMetadata.portalId
    : undefined;

  const rootId = typeof projectMetadata?.portalRootId === 'string' ? projectMetadata.portalRootId : undefined;
  const repoPath = typeof projectMetadata?.repoPath === 'string' ? projectMetadata.repoPath : undefined;

  const workspacePath = typeof workspace?.path === 'string' ? workspace.path : undefined;
  if ((projectMetadata?.projectKind === 'git' || projectMetadata?.projectKind === 'notes') && !workspacePath) {
    throw new Error('This Workspace has no local path yet. Create it again or attach an existing location.');
  }

  const projectKind = projectMetadata?.projectKind === 'git' || projectMetadata?.projectKind === 'notes'
    ? projectMetadata.projectKind
    : 'general';

  return {
    resourceId,
    projectId: metadata.projectId,
    workspaceId: metadata.workspaceId,
    projectKind,
    portalId,
    rootId,
    repoPath,
    workspacePath,
  };
};

export const routePortalTool = async (tool: string, args: unknown, context: any, timeoutMs?: number) => {
  const binding = await getThreadBinding(context);
  const portalId = await resolvePortalForBinding(binding);
  if (!portalId) return { ok: false, error: offlineMessage };

  return toolService.requestPortal({
    caller: callerForOwner(binding.resourceId, 'agent', {
      threadId: typeof context.agent?.threadId === 'string' ? context.agent.threadId : undefined,
    }),
    target: {
      portalId,
      projectId: binding.projectId,
      workspaceId: binding.workspaceId,
      rootId: binding.rootId,
      repoPath: binding.repoPath,
      workspacePath: binding.workspacePath,
    },
    tool,
    args,
    timeoutMs,
  });
};

export const resolvePortalForBinding = async (binding: Awaited<ReturnType<typeof getThreadBinding>>) => {
  try {
    return (await toolService.resolvePortalTarget(
      callerForOwner(binding.resourceId, 'agent'),
      portalToolScope({
        portalId: binding.portalId,
        projectId: binding.projectId,
        rootId: binding.rootId,
        repoPath: binding.repoPath,
        workspacePath: binding.workspacePath,
      }),
    )).portalId;
  } catch (error) {
    if (error instanceof ServiceError && error.code === 'provider_offline') return undefined;
    throw error;
  }
};

type FileToolAction = 'index' | 'read' | 'write' | 'mkdir' | 'move' | 'delete' | 'upload';

const routeNotesFileTool = async (
  action: FileToolAction,
  args: unknown,
  context: any,
  timeoutMs?: number,
  deps: NotesVaultResolverDependencies = {},
) => {
  try {
    const threadId = typeof context.agent?.threadId === 'string' ? context.agent.threadId : undefined;
    const correlation = threadId ? { threadId } : undefined;
    const defaultTools = deps.tools ?? (deps.getBackend ? undefined : toolService);
    const serviceDeps: NotesVaultResolverDependencies = {
      callerKind: 'agent',
      correlation,
      ...(defaultTools
        ? {
          tools: defaultTools,
          getBackend: (kind: string) =>
            kind === 'portal'
              ? createServicePortalNotesVaultBackend(defaultTools, { callerKind: 'agent', correlation })
              : getNotesVaultBackend(kind),
        }
        : {}),
      ...deps,
    };
    const { backend, binding } = await resolveNotesVaultForThreadContext(context, serviceDeps);
    return await backend[action](binding, args as never, timeoutMs ? { timeoutMs } : undefined);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

type PortalBaseOutput = {
  ok: boolean;
  error?: string;
  path?: string;
  command?: string;
};

type PortalReadOutput = PortalBaseOutput & {
  content?: string;
  offset?: number;
  limit?: number;
};

type PortalWriteOutput = PortalBaseOutput & {
  bytes?: number;
};

type PortalEditOutput = PortalBaseOutput & {
  replacements?: number;
  diff?: string;
};

type PortalBashOutput = PortalBaseOutput & {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
};

export const normalizePortalResult = (result: unknown) => {
  const record = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  const hasExplicitStatus = typeof record.ok === 'boolean';
  const ok = hasExplicitStatus ? record.ok as boolean : false;
  const error = typeof record.error === 'string'
    ? record.error
    : hasExplicitStatus
    ? undefined
    : 'Portal returned a malformed result without an ok status';
  return { ...record, ok, ...(error ? { error } : {}) };
};

const withPortalMetadata = <T extends PortalBaseOutput>(
  result: unknown,
  metadata: Omit<Partial<T>, 'ok' | 'error'>,
): T => {
  const record = normalizePortalResult(result);

  return {
    ...record,
    ...metadata,
  } as T;
};

const withFileMetadata = <T extends PortalBaseOutput>(
  result: unknown,
  metadata?: Omit<Partial<T>, 'ok' | 'error'>,
): T => {
  const record = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  const ok = record.ok !== false;
  const error = typeof record.error === 'string'
    ? record.error
    : ok
    ? undefined
    : 'Portal returned an invalid file result';

  return {
    ...record,
    ok,
    ...(error ? { error } : {}),
    ...(metadata ?? {}),
  } as T;
};

const portalBaseOutputSchema = {
  ok: z.boolean(),
  error: z.string().optional(),
  path: z.string().optional(),
  command: z.string().optional(),
};

const editToolModelOutputMaxChars = 1_600;
const editDiffSummaryMaxLines = 80;

const isDiffChangeLine = (line: string) =>
  (line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'));

type EditDiffSummary = {
  body?: string;
  diffChars?: number;
  diffHash?: string;
  diffLines?: number;
  diffSummaryLines?: number;
  diffOmittedLines?: number;
};

const summarizeEditDiff = (diff: unknown): EditDiffSummary => {
  if (typeof diff !== 'string' || !diff.trim()) return {};

  const diffLines = diff.split('\n');
  const summaryLines: string[] = [];
  let omittedLines = 0;

  diffLines.forEach((line) => {
    if (line.startsWith('@@ ') || isDiffChangeLine(line)) {
      if (summaryLines.length < editDiffSummaryMaxLines) {
        summaryLines.push(line);
      } else {
        omittedLines += 1;
      }
      return;
    }

    omittedLines += 1;
  });

  const body = summaryLines.length
    ? [
      'diff summary (hunk headers and changed lines only):',
      ...summaryLines,
      ...(omittedLines
        ? [`... ${omittedLines} diff lines omitted. Use read or git_diff for surrounding context.`]
        : []),
    ].join('\n')
    : undefined;

  return {
    body,
    diffChars: diff.length,
    diffHash: hashText(diff),
    diffLines: diffLines.length,
    diffSummaryLines: summaryLines.length,
    diffOmittedLines: omittedLines || undefined,
  };
};

export const portalReadModelOutput = (output: unknown, maxChars = getCodeToolModelOutputMaxChars()) => {
  const result = output && typeof output === 'object' ? output as Record<string, unknown> : {};
  return formatToolModelOutput(
    'read',
    [
      ['ok', result.ok],
      ['path', result.path],
      ['offset', result.offset],
      ['limit', result.limit],
      ['error', result.error],
    ],
    result.content,
    maxChars,
  );
};

export const portalWriteModelOutput = (output: unknown) => {
  const result = output && typeof output === 'object' ? output as Record<string, unknown> : {};
  return formatToolModelOutput('write', [
    ['ok', result.ok],
    ['path', result.path],
    ['bytes', result.bytes],
    ['error', result.error],
  ]);
};

export const portalEditModelOutput = (output: unknown, maxChars = editToolModelOutputMaxChars) => {
  const result = output && typeof output === 'object' ? output as Record<string, unknown> : {};
  const diffSummary = summarizeEditDiff(result.diff);
  return formatToolModelOutput(
    'edit',
    [
      ['ok', result.ok],
      ['path', result.path],
      ['replacements', result.replacements],
      ['diffChars', diffSummary.diffChars],
      ['diffHash', diffSummary.diffHash],
      ['diffLines', diffSummary.diffLines],
      ['diffSummaryLines', diffSummary.diffSummaryLines],
      ['diffOmittedLines', diffSummary.diffOmittedLines],
      ['error', result.error],
    ],
    diffSummary.body,
    maxChars,
  );
};

export const portalBashModelOutput = (output: unknown, maxChars = getCodeToolModelOutputMaxChars()) => {
  const result = output && typeof output === 'object' ? output as Record<string, unknown> : {};
  const body = [
    result.stdout ? `stdout:\n${result.stdout}` : '',
    result.stderr ? `stderr:\n${result.stderr}` : '',
  ].filter(Boolean).join('\n\n');

  return formatToolModelOutput(
    'bash',
    [
      ['ok', result.ok],
      ['command', result.command],
      ['exitCode', result.exitCode],
      ['timedOut', result.timedOut],
      ['error', result.error],
    ],
    body,
    maxChars,
  );
};

const payloadTextMaxInlineChars = 2_000;
const payloadTextPreviewChars = 1_200;

const payloadTextSummary = (value: unknown, prefix: string) => {
  if (typeof value !== 'string') return {};
  if (value.length <= payloadTextMaxInlineChars) return { [prefix]: value };
  return {
    [`${prefix}Chars`]: value.length,
    [`${prefix}Hash`]: hashText(value),
    [`${prefix}Preview`]: value.slice(0, payloadTextPreviewChars),
    [`${prefix}Truncated`]: true,
  };
};

const payloadErrorPreview = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value
    .split(/\r?\n/)
    .filter((line) => /error|failed|exception|traceback|denied|not found|invalid/i.test(line))
    .slice(0, 8)
    .join('\n')
    .slice(0, payloadTextPreviewChars) || undefined;
};

const portalReadPayloadInputSummary = ({ input }: { input?: unknown }) => {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  return {
    ...(typeof record.path === 'string' ? { path: record.path } : {}),
    ...(typeof record.offset === 'number' ? { offset: record.offset } : {}),
    ...(typeof record.limit === 'number' ? { limit: record.limit } : {}),
  };
};

const portalReadPayloadOutputSummary = ({ output }: { output?: unknown }) => {
  const result = output && typeof output === 'object' ? output as Record<string, unknown> : {};
  return {
    ok: result.ok,
    ...(typeof result.path === 'string' ? { path: result.path } : {}),
    ...(typeof result.offset === 'number' ? { offset: result.offset } : {}),
    ...(typeof result.limit === 'number' ? { limit: result.limit } : {}),
    ...(typeof result.error === 'string' ? { error: result.error } : {}),
    ...payloadTextSummary(result.content, 'content'),
  };
};

const portalBashPayloadInputSummary = ({ input }: { input?: unknown }) => {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  return {
    ...payloadTextSummary(record.command, 'command'),
    ...(typeof record.timeout === 'number' ? { timeout: record.timeout } : {}),
  };
};

const portalBashPayloadOutputSummary = ({ output }: { output?: unknown }) => {
  const result = output && typeof output === 'object' ? output as Record<string, unknown> : {};
  return {
    ok: result.ok,
    ...payloadTextSummary(result.command, 'command'),
    ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
    ...(typeof result.timedOut === 'boolean' ? { timedOut: result.timedOut } : {}),
    ...(typeof result.error === 'string' ? { error: result.error } : {}),
    ...payloadTextSummary(result.stdout, 'stdout'),
    ...payloadTextSummary(result.stderr, 'stderr'),
    ...(payloadErrorPreview(result.stderr) ? { stderrErrors: payloadErrorPreview(result.stderr) } : {}),
    ...(payloadErrorPreview(result.stdout) ? { stdoutErrors: payloadErrorPreview(result.stdout) } : {}),
  };
};

const portalReadPayloadTransform = {
  display: {
    input: portalReadPayloadInputSummary,
    output: portalReadPayloadOutputSummary,
  },
  transcript: {
    input: portalReadPayloadInputSummary,
    output: portalReadPayloadOutputSummary,
  },
};

const portalBashPayloadTransform = {
  display: {
    input: portalBashPayloadInputSummary,
    output: portalBashPayloadOutputSummary,
  },
  transcript: {
    input: portalBashPayloadInputSummary,
    output: portalBashPayloadOutputSummary,
  },
};

const fileIndexModelOutput = (output: unknown, maxChars = getCodeToolModelOutputMaxChars()) => {
  const result = output && typeof output === 'object' ? output as Record<string, any> : {};
  const notes = Array.isArray(result.notes) ? result.notes : [];
  const attachments = Array.isArray(result.attachments) ? result.attachments : [];
  const backlinks = result.backlinks && typeof result.backlinks === 'object'
    ? result.backlinks as Record<string, string[]>
    : {};
  const body = notes.slice(0, 80).map((note: any) => {
    const noteBacklinks = Array.isArray(backlinks[note.path]) ? backlinks[note.path].length : 0;
    const tags = Array.isArray(note.tags) && note.tags.length ? ` tags=${note.tags.join(',')}` : '';
    return `- ${note.path}${note.title ? ` (${note.title})` : ''}${tags} links=${
      Array.isArray(note.links) ? note.links.length : 0
    } backlinks=${noteBacklinks}`;
  }).join('\n');

  return formatToolModelOutput(
    'file_index',
    [
      ['ok', result.ok],
      ['path', result.path],
      ['notes', notes.length],
      ['attachments', attachments.length],
      ['error', result.error],
    ],
    body,
    maxChars,
  );
};

const fileReadModelOutput = (output: unknown, maxChars = getCodeToolModelOutputMaxChars()) => {
  const result = output && typeof output === 'object' ? output as Record<string, unknown> : {};
  return formatToolModelOutput(
    'file_read',
    [
      ['ok', result.ok],
      ['path', result.path],
      ['version', result.version],
      ['error', result.error],
    ],
    result.content,
    maxChars,
  );
};

const fileOperationModelOutput = (name: string, output: unknown) => {
  const result = output && typeof output === 'object' ? output as Record<string, unknown> : {};
  return formatToolModelOutput(name, [
    ['ok', result.ok],
    ['path', result.path],
    ['version', result.version],
    ['error', result.error],
  ]);
};

export const portalReadTool = createTool({
  id: 'read',
  description: toolDescription('read'),
  inputSchema: z.object({
    path: z.string().describe(toolInputDescription('read', 'path')),
    offset: z.number().optional().describe(toolInputDescription('read', 'offset')),
    limit: z.number().optional().describe(toolInputDescription('read', 'limit')),
  }),
  outputSchema: z.object({
    ...portalBaseOutputSchema,
    content: z.string().optional(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
  execute: async (input, context): Promise<PortalReadOutput> =>
    withPortalMetadata<PortalReadOutput>(await routePortalTool('read', input, context), {
      path: input.path,
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    }),
  transform: portalReadPayloadTransform,
  toModelOutput: portalReadModelOutput,
});

export const portalWriteTool = createTool({
  id: 'write',
  description: toolDescription('write'),
  inputSchema: z.object({
    path: z.string().describe(toolInputDescription('write', 'path')),
    content: z.string().describe(toolInputDescription('write', 'content')),
  }),
  outputSchema: z.object({ ...portalBaseOutputSchema, bytes: z.number().optional() }),
  execute: async (input, context): Promise<PortalWriteOutput> =>
    withPortalMetadata<PortalWriteOutput>(await routePortalTool('write', input, context), { path: input.path }),
  toModelOutput: portalWriteModelOutput,
});

export const portalEditTool = createTool({
  id: 'edit',
  description: toolDescription('edit'),
  inputSchema: z.object({
    path: z.string().describe(toolInputDescription('edit', 'path')),
    edits: z.array(
      z.object({
        oldText: z.string().describe(toolInputDescription('edit', 'edits[].oldText')),
        newText: z.string().describe(toolInputDescription('edit', 'edits[].newText')),
      }).strict(),
    ).min(1),
  }),
  outputSchema: z.object({
    ...portalBaseOutputSchema,
    replacements: z.number().optional(),
    diff: z.string().optional(),
  }),
  execute: async (input, context): Promise<PortalEditOutput> =>
    withPortalMetadata<PortalEditOutput>(await routePortalTool('edit', input, context), { path: input.path }),
  toModelOutput: portalEditModelOutput,
});

export const portalBashTool = createTool({
  id: 'bash',
  description: toolDescription('bash'),
  inputSchema: z.object({
    command: z.string().describe(toolInputDescription('bash', 'command')),
    timeout: z.number().optional().describe(toolInputDescription('bash', 'timeout')),
  }),
  outputSchema: z.object({
    ...portalBaseOutputSchema,
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exitCode: z.number().optional(),
    timedOut: z.boolean().optional(),
  }),
  execute: async (input, context): Promise<PortalBashOutput> =>
    withPortalMetadata<PortalBashOutput>(
      await routePortalTool('bash', input, context, input.timeout ? input.timeout * 1000 + 1000 : undefined),
      { command: input.command },
    ),
  transform: portalBashPayloadTransform,
  toModelOutput: portalBashModelOutput,
});

export const fileIndexTool = createTool({
  id: 'file_index',
  description: toolDescription('file_index'),
  inputSchema: z.object({
    path: z.string().optional().describe(toolInputDescription('file_index', 'path')),
  }),
  outputSchema: z.object({
    ...portalBaseOutputSchema,
    checkedAt: z.string().optional(),
    notes: z.array(z.any()).optional(),
    attachments: z.array(z.any()).optional(),
    backlinks: z.record(z.string(), z.array(z.string())).optional(),
  }),
  execute: async (input, context): Promise<PortalBaseOutput> =>
    withFileMetadata(await routeNotesFileTool('index', input, context, 30_000), {}),
  toModelOutput: fileIndexModelOutput,
});

export const fileReadTool = createTool({
  id: 'file_read',
  description: toolDescription('file_read'),
  inputSchema: z.object({
    path: z.string().describe(toolInputDescription('file_read', 'path')),
  }),
  outputSchema: z.object({
    ...portalBaseOutputSchema,
    content: z.string().optional(),
    version: z.string().optional(),
  }),
  execute: async (input, context): Promise<PortalBaseOutput> =>
    withFileMetadata(await routeNotesFileTool('read', input, context), { path: input.path }),
  toModelOutput: fileReadModelOutput,
});

export const fileWriteTool = createTool({
  id: 'file_write',
  description: toolDescription('file_write'),
  inputSchema: z.object({
    path: z.string().describe(toolInputDescription('file_write', 'path')),
    content: z.string().describe(toolInputDescription('file_write', 'content')),
    version: z.string().optional().describe(toolInputDescription('file_write', 'version')),
  }),
  outputSchema: z.object({ ...portalBaseOutputSchema, version: z.string().optional() }),
  execute: async (input, context): Promise<PortalBaseOutput> =>
    withFileMetadata(await routeNotesFileTool('write', input, context), { path: input.path }),
  toModelOutput: (output) => fileOperationModelOutput('file_write', output),
});

export const fileMkdirTool = createTool({
  id: 'file_mkdir',
  description: toolDescription('file_mkdir'),
  inputSchema: z.object({
    path: z.string().describe(toolInputDescription('file_mkdir', 'path')),
  }),
  outputSchema: z.object(portalBaseOutputSchema),
  execute: async (input, context): Promise<PortalBaseOutput> =>
    withFileMetadata(await routeNotesFileTool('mkdir', input, context), { path: input.path }),
  toModelOutput: (output) => fileOperationModelOutput('file_mkdir', output),
});

export const fileMoveTool = createTool({
  id: 'file_move',
  description: toolDescription('file_move'),
  inputSchema: z.object({
    fromPath: z.string().describe(toolInputDescription('file_move', 'fromPath')),
    toPath: z.string().describe(toolInputDescription('file_move', 'toPath')),
    overwrite: z.boolean().optional().describe(toolInputDescription('file_move', 'overwrite')),
  }),
  outputSchema: z.object(portalBaseOutputSchema),
  execute: async (input, context): Promise<PortalBaseOutput> =>
    withFileMetadata(await routeNotesFileTool('move', input, context), { path: input.toPath }),
  toModelOutput: (output) => fileOperationModelOutput('file_move', output),
});

export const fileDeleteTool = createTool({
  id: 'file_delete',
  description: toolDescription('file_delete'),
  inputSchema: z.object({
    path: z.string().describe(toolInputDescription('file_delete', 'path')),
    recursive: z.boolean().optional().describe(toolInputDescription('file_delete', 'recursive')),
  }),
  outputSchema: z.object(portalBaseOutputSchema),
  execute: async (input, context): Promise<PortalBaseOutput> =>
    withFileMetadata(await routeNotesFileTool('delete', input, context), { path: input.path }),
  toModelOutput: (output) => fileOperationModelOutput('file_delete', output),
});

export const fileUploadTool = createTool({
  id: 'file_upload',
  description: toolDescription('file_upload'),
  inputSchema: z.object({
    path: z.string().describe(toolInputDescription('file_upload', 'path')),
    base64Content: z.string().describe(toolInputDescription('file_upload', 'base64Content')),
    contentType: z.string().optional().describe(toolInputDescription('file_upload', 'contentType')),
  }),
  outputSchema: z.object(portalBaseOutputSchema),
  execute: async (input, context): Promise<PortalBaseOutput> =>
    withFileMetadata(await routeNotesFileTool('upload', input, context), { path: input.path }),
  toModelOutput: (output) => fileOperationModelOutput('file_upload', output),
});

export const __portalToolsTest = {
  routeNotesFileTool,
};
