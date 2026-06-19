import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { findPortalForProject, requestPortalTool } from '../portal/registry';
import { formatToolModelOutput, getCodeToolModelOutputMaxChars, hashText } from './model-output';

export const offlineMessage = 'This thread is not bound to an active Workspace. Connect a Portal or choose a Project with an online Portal to use local tools.';

const projectThreadId = (projectId: string) => `__project__${projectId}`;

export const getThreadBinding = async (context: any) => {
  const threadId = context.agent?.threadId;
  const contextResourceId = context.agent?.resourceId;
  if (!threadId) throw new Error(offlineMessage);

  const agent = await context.mastra?.getAgent('mageHandAgent');
  const memory = await agent?.getMemory();
  const thread = await memory?.getThreadById({ threadId });
  const resourceId = typeof contextResourceId === 'string' && contextResourceId ? contextResourceId : thread?.resourceId;
  const metadata = thread?.metadata as Record<string, unknown> | undefined;

  if (!thread || !resourceId || thread.resourceId !== resourceId) throw new Error(offlineMessage);
  if (metadata?.mode !== 'project' || typeof metadata.projectId !== 'string' || typeof metadata.workspaceId !== 'string') {
    throw new Error(offlineMessage);
  }

  const projectThread = await memory?.getThreadById({ threadId: projectThreadId(metadata.projectId) }).catch(() => undefined);
  const projectMetadata = projectThread?.metadata as Record<string, any> | undefined;
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

  return { resourceId, projectId: metadata.projectId, workspaceId: metadata.workspaceId, projectKind, portalId, rootId, repoPath, workspacePath };
};

export const routePortalTool = async (tool: string, args: unknown, context: any, timeoutMs?: number) => {
  const binding = await getThreadBinding(context);
  const mountedPortal = findPortalForProject(binding.resourceId, binding.projectId);
  const portalId = binding.portalId ?? mountedPortal?.portalId;
  if (!portalId) return { ok: false, error: offlineMessage };

  return requestPortalTool({
    portalId,
    projectId: binding.projectId,
    workspaceId: binding.workspaceId,
    rootId: binding.rootId,
    repoPath: binding.repoPath,
    workspacePath: binding.workspacePath,
    tool,
    args,
    timeoutMs,
  });
};

const routeNotesVaultTool = async (tool: string, args: unknown, context: any, timeoutMs?: number) => {
  const binding = await getThreadBinding(context);
  if (binding.projectKind !== 'notes') return { ok: false, error: 'Vault tools are only available in Notes Project threads.' };
  const mountedPortal = findPortalForProject(binding.resourceId, binding.projectId);
  const portalId = binding.portalId ?? mountedPortal?.portalId;
  if (!portalId) return { ok: false, error: offlineMessage };

  return requestPortalTool({
    portalId,
    projectId: binding.projectId,
    workspaceId: binding.workspaceId,
    rootId: binding.rootId,
    repoPath: binding.repoPath,
    workspacePath: binding.workspacePath,
    tool,
    args,
    timeoutMs,
  });
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
};

const withPortalMetadata = <T extends PortalBaseOutput>(result: unknown, metadata: Omit<Partial<T>, 'ok' | 'error'>): T => {
  const record = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  const ok = typeof record.ok === 'boolean' ? record.ok : false;
  const error = typeof record.error === 'string'
    ? record.error
    : ok ? undefined : 'Portal returned an invalid result';

  return {
    ...record,
    ok,
    ...(error ? { error } : {}),
    ...metadata,
  } as T;
};

const withVaultMetadata = <T extends PortalBaseOutput>(result: unknown, metadata?: Omit<Partial<T>, 'ok' | 'error'>): T => {
  const record = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  const ok = record.ok !== false;
  const error = typeof record.error === 'string'
    ? record.error
    : ok ? undefined : 'Portal returned an invalid vault result';

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

  diffLines.forEach(line => {
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
      ...(omittedLines ? [`... ${omittedLines} diff lines omitted. Use read or git_diff for surrounding context.`] : []),
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
      ['error', result.error],
    ],
    body,
    maxChars,
  );
};

const vaultIndexModelOutput = (output: unknown, maxChars = getCodeToolModelOutputMaxChars()) => {
  const result = output && typeof output === 'object' ? output as Record<string, any> : {};
  const notes = Array.isArray(result.notes) ? result.notes : [];
  const attachments = Array.isArray(result.attachments) ? result.attachments : [];
  const backlinks = result.backlinks && typeof result.backlinks === 'object' ? result.backlinks as Record<string, string[]> : {};
  const body = notes.slice(0, 80).map((note: any) => {
    const noteBacklinks = Array.isArray(backlinks[note.path]) ? backlinks[note.path].length : 0;
    const tags = Array.isArray(note.tags) && note.tags.length ? ` tags=${note.tags.join(',')}` : '';
    return `- ${note.path}${note.title ? ` (${note.title})` : ''}${tags} links=${Array.isArray(note.links) ? note.links.length : 0} backlinks=${noteBacklinks}`;
  }).join('\n');

  return formatToolModelOutput(
    'vault_index',
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

const vaultReadModelOutput = (output: unknown, maxChars = getCodeToolModelOutputMaxChars()) => {
  const result = output && typeof output === 'object' ? output as Record<string, unknown> : {};
  return formatToolModelOutput(
    'vault_read',
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

const vaultOperationModelOutput = (name: string, output: unknown) => {
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
  description: 'Read the contents of a file from the current Workspace through a connected Portal. Text output is truncated to 2000 lines or 50KB. Use offset/limit for large files. When you need the full file, continue with offset until complete.',
  inputSchema: z.object({
    path: z.string().describe('Path to the file to read, relative to the Workspace root'),
    offset: z.number().optional().describe('Line number to start reading from, 1-indexed'),
    limit: z.number().optional().describe('Maximum number of lines to read'),
  }),
  outputSchema: z.object({
    ...portalBaseOutputSchema,
    content: z.string().optional(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
  execute: async (input, context): Promise<PortalReadOutput> => withPortalMetadata<PortalReadOutput>(await routePortalTool('read', input, context), {
    path: input.path,
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  }),
  toModelOutput: portalReadModelOutput,
});

export const portalWriteTool = createTool({
  id: 'write',
  description: 'Write content to a file in the current Workspace through a connected Portal. Creates the file if it does not exist, overwrites if it does. Automatically creates parent directories.',
  inputSchema: z.object({
    path: z.string().describe('Path to write, relative to the Workspace root'),
    content: z.string().describe('Full file content'),
  }),
  outputSchema: z.object({ ...portalBaseOutputSchema, bytes: z.number().optional() }),
  execute: async (input, context): Promise<PortalWriteOutput> =>
    withPortalMetadata<PortalWriteOutput>(await routePortalTool('write', input, context), { path: input.path }),
  toModelOutput: portalWriteModelOutput,
});

export const portalEditTool = createTool({
  id: 'edit',
  description: 'Edit a single file in the current Workspace using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. Each edit is matched against the original file, not incrementally. If two changes affect nearby or overlapping lines, merge them into one edit.',
  inputSchema: z.object({
    path: z.string().describe('Path to edit, relative to the Workspace root'),
    edits: z.array(z.object({
      oldText: z.string().describe('Exact text for one targeted replacement. Must be unique in the original file and non-overlapping with other edits.'),
      newText: z.string().describe('Replacement text for this targeted edit.'),
    }).strict()).min(1),
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
  description: 'Run a bash command in the current Workspace through a connected Portal. Prefer `fd`, `rg`, and `ls` for file discovery/search.',
  inputSchema: z.object({
    command: z.string().describe('Bash command to execute'),
    timeout: z.number().optional().describe('Timeout in seconds'),
  }),
  outputSchema: z.object({
    ...portalBaseOutputSchema,
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exitCode: z.number().optional(),
  }),
  execute: async (input, context): Promise<PortalBashOutput> => withPortalMetadata<PortalBashOutput>(
    await routePortalTool('bash', input, context, input.timeout ? input.timeout * 1000 + 1000 : undefined),
    { command: input.command },
  ),
  toModelOutput: portalBashModelOutput,
});

export const vaultIndexTool = createTool({
  id: 'vault_index',
  description: 'Index the current Notes Project vault. Returns Markdown note metadata, wiki links, embeds, tags, attachments, and backlinks.',
  inputSchema: z.object({
    path: z.string().optional().describe('Optional folder path relative to the vault root'),
  }),
  outputSchema: z.object({
    ...portalBaseOutputSchema,
    checkedAt: z.string().optional(),
    notes: z.array(z.any()).optional(),
    attachments: z.array(z.any()).optional(),
    backlinks: z.record(z.string(), z.array(z.string())).optional(),
  }),
  execute: async (input, context): Promise<PortalBaseOutput> => withVaultMetadata(await routeNotesVaultTool('portal.vault.index', input, context, 30_000), {}),
  toModelOutput: vaultIndexModelOutput,
});

export const vaultReadTool = createTool({
  id: 'vault_read',
  description: 'Read a Markdown, Canvas JSON, JSON, or Excalidraw text file from the current Notes Project vault.',
  inputSchema: z.object({
    path: z.string().describe('Path to read, relative to the vault root'),
  }),
  outputSchema: z.object({
    ...portalBaseOutputSchema,
    content: z.string().optional(),
    version: z.string().optional(),
  }),
  execute: async (input, context): Promise<PortalBaseOutput> =>
    withVaultMetadata(await routeNotesVaultTool('portal.vault.read', input, context), { path: input.path }),
  toModelOutput: vaultReadModelOutput,
});

export const vaultWriteTool = createTool({
  id: 'vault_write',
  description: 'Write a Markdown, Canvas JSON, JSON, or Excalidraw text file in the current Notes Project vault. Creates parent folders as needed.',
  inputSchema: z.object({
    path: z.string().describe('Path to write, relative to the vault root'),
    content: z.string().describe('Full file content'),
    version: z.string().optional().describe('Optional optimistic file version returned by vault_read'),
  }),
  outputSchema: z.object({ ...portalBaseOutputSchema, version: z.string().optional() }),
  execute: async (input, context): Promise<PortalBaseOutput> =>
    withVaultMetadata(await routeNotesVaultTool('portal.vault.write', input, context), { path: input.path }),
  toModelOutput: output => vaultOperationModelOutput('vault_write', output),
});

export const vaultMkdirTool = createTool({
  id: 'vault_mkdir',
  description: 'Create a folder in the current Notes Project vault.',
  inputSchema: z.object({
    path: z.string().describe('Folder path to create, relative to the vault root'),
  }),
  outputSchema: z.object(portalBaseOutputSchema),
  execute: async (input, context): Promise<PortalBaseOutput> =>
    withVaultMetadata(await routeNotesVaultTool('portal.vault.mkdir', input, context), { path: input.path }),
  toModelOutput: output => vaultOperationModelOutput('vault_mkdir', output),
});

export const vaultMoveTool = createTool({
  id: 'vault_move',
  description: 'Rename or move a file or folder in the current Notes Project vault.',
  inputSchema: z.object({
    fromPath: z.string().describe('Existing path relative to the vault root'),
    toPath: z.string().describe('Destination path relative to the vault root'),
    overwrite: z.boolean().optional().describe('Whether to overwrite an existing destination'),
  }),
  outputSchema: z.object(portalBaseOutputSchema),
  execute: async (input, context): Promise<PortalBaseOutput> =>
    withVaultMetadata(await routeNotesVaultTool('portal.vault.move', input, context), { path: input.toPath }),
  toModelOutput: output => vaultOperationModelOutput('vault_move', output),
});

export const vaultDeleteTool = createTool({
  id: 'vault_delete',
  description: 'Delete a file or folder from the current Notes Project vault.',
  inputSchema: z.object({
    path: z.string().describe('Path to delete, relative to the vault root'),
    recursive: z.boolean().optional().describe('Required for deleting non-empty folders'),
  }),
  outputSchema: z.object(portalBaseOutputSchema),
  execute: async (input, context): Promise<PortalBaseOutput> =>
    withVaultMetadata(await routeNotesVaultTool('portal.vault.delete', input, context), { path: input.path }),
  toModelOutput: output => vaultOperationModelOutput('vault_delete', output),
});

export const vaultUploadTool = createTool({
  id: 'vault_upload',
  description: 'Upload a binary attachment into the current Notes Project vault from base64-encoded content.',
  inputSchema: z.object({
    path: z.string().describe('Attachment path to write, relative to the vault root'),
    base64Content: z.string().describe('Base64-encoded file content'),
    contentType: z.string().optional().describe('Optional MIME type for the attachment'),
  }),
  outputSchema: z.object(portalBaseOutputSchema),
  execute: async (input, context): Promise<PortalBaseOutput> =>
    withVaultMetadata(await routeNotesVaultTool('portal.vault.upload', input, context), { path: input.path }),
  toModelOutput: output => vaultOperationModelOutput('vault_upload', output),
});
