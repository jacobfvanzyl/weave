import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { formatToolModelOutput, hashText } from './model-output';
import {
  assertProposalItemsCompleteForStatuses,
  countProposalChanges,
  inferProposalStatus,
  parseProposalArtifact,
  proposalDirectory,
  proposalFrontmatterSchema,
  proposalItemSchema,
  proposalItemStatusSchema,
  proposalPathForName,
  proposalSnapshotFromFrontmatter,
  renderProposalArtifact,
  validateProposalPath,
  type ProposalBody,
  type ProposalFrontmatter,
  type ProposalItem,
} from './proposal-artifacts';
import { getThreadBinding, offlineMessage, routePortalTool } from './portal-tools';

const proposalToolOutputSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  updated: z.boolean(),
  applied: z.number().optional(),
  stale: z.number().optional(),
  skipped: z.number().optional(),
  version: z.number().optional(),
  id: z.string().optional(),
  title: z.string().optional(),
  path: z.string().optional(),
  planPath: z.string().optional(),
  status: z.string().optional(),
  summary: z.string().optional(),
  items: z.array(proposalItemSchema).optional(),
  counts: z.record(z.string(), z.number()).optional(),
  updatedAt: z.string().optional(),
  contentHash: z.string().optional(),
  bytes: z.number().optional(),
}).strict();

const proposalCodeItemKindSchema = z.enum(['file_edit', 'file_create', 'file_delete']);

const proposalFileInputSchema = z.object({
  id: z.string().min(1).max(100).optional(),
  kind: proposalCodeItemKindSchema.default('file_edit'),
  title: z.string().min(1).max(240).optional(),
  path: z.string().min(1),
  description: z.string().optional().describe('Optional human-readable description of this item. Do not put proposed code here.'),
  rationale: z.string().optional(),
  diff: z.string().optional().describe('Concrete unified diff hunk(s) for this file. Required for file proposals unless currentContent and proposedContent are provided.'),
  currentContent: z.string().optional().describe('Exact current file content or relevant current code hunk before the proposed change.'),
  proposedContent: z.string().optional().describe('Exact proposed file content or relevant proposed code hunk after the change.'),
  currentHash: z.string().optional(),
}).strict().refine(file => {
  if (file.kind === 'file_create') return typeof file.proposedContent === 'string';
  if (file.kind === 'file_delete') return typeof file.currentContent === 'string';
  return typeof file.currentContent === 'string' && typeof file.proposedContent === 'string';
}, {
  message: 'File proposal items must include concrete body content: file_edit needs currentContent and proposedContent, file_create needs proposedContent, and file_delete needs currentContent.',
});

const writeProposalInputSchema = z.object({
  title: z.string().min(1).max(180),
  summary: z.string().min(1).max(500),
  proposalPath: z.string().optional().describe(`Optional artifact path. Must be ${proposalDirectory}/<name>.md.`),
  planPath: z.string().optional().describe('Optional linked plan artifact path.'),
  status: z.enum(['draft', 'ready']).optional(),
  overview: z.string().optional(),
  files: z.array(proposalFileInputSchema).min(1).max(120),
}).strict();

const proposalItemUpdateInputSchema = z.object({
  id: z.string().min(1).max(100),
  status: proposalItemStatusSchema.optional(),
  viewed: z.boolean().optional(),
  comment: z.string().optional(),
}).strict().refine(value => value.status || typeof value.viewed === 'boolean' || typeof value.comment === 'string', {
  message: 'Provide at least one item update',
});

const updateProposalInputSchema = z.object({
  proposalPath: z.string().optional().describe(`Optional artifact path. Omit to use the thread's latest proposal. Must be ${proposalDirectory}/<name>.md.`),
  status: z.enum(['draft', 'ready', 'partially_approved', 'approved', 'changes_requested', 'applied', 'rejected', 'stale']).optional(),
  approveAllPending: z.boolean().optional(),
  approveAllViewed: z.boolean().optional(),
  rejectAllPending: z.boolean().optional(),
  requestChanges: z.string().optional(),
  items: z.array(proposalItemUpdateInputSchema).max(120).optional(),
}).strict().refine(value => Boolean(
  value.status
  || value.approveAllPending
  || value.approveAllViewed
  || value.rejectAllPending
  || value.requestChanges
  || value.items?.length
), { message: 'Provide at least one proposal update' });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const toolError = (error: unknown, path?: string) => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
  updated: false,
  ...(path ? { path } : {}),
});

const portalError = (result: unknown, fallback: string) => {
  const record = isRecord(result) ? result : {};
  return typeof record.error === 'string' && record.error ? record.error : fallback;
};

const readPortalFile = async (path: string, context: any) => {
  const result = await routePortalTool('read', { path }, context);
  const record = isRecord(result) ? result : {};
  if (record.ok !== true) return { ok: false as const, error: portalError(result, `Unable to read ${path}`) };
  if (typeof record.content !== 'string') return { ok: false as const, error: `Portal read returned no content for ${path}` };
  return { ok: true as const, content: record.content };
};

const writePortalFile = async (path: string, content: string, context: any) => {
  const result = await routePortalTool('write', { path, content }, context);
  const record = isRecord(result) ? result : {};
  if (record.ok !== true) return { ok: false as const, error: portalError(result, `Unable to write ${path}`) };
  return { ok: true as const, bytes: typeof record.bytes === 'number' ? record.bytes : undefined };
};

const getThreadRecord = async (context: any) => {
  const threadId = context.agent?.threadId;
  const resourceId = context.agent?.resourceId;
  if (!threadId || !resourceId) throw new Error(offlineMessage);

  const agent = await context.mastra?.getAgent('mageHandAgent');
  const memory = await agent?.getMemory();
  if (!memory) throw new Error('mageHandAgent has no memory configured');

  const thread = await memory.getThreadById({ threadId });
  if (!thread || thread.resourceId !== resourceId) throw new Error(offlineMessage);
  return { threadId, memory, thread };
};

const getGitProposalBinding = async (context: any) => {
  const binding = await getThreadBinding(context);
  if (binding.projectKind !== 'git') {
    throw new Error('Proposal artifacts are only available in Git Project Workspace threads.');
  }
  return binding;
};

const threadIdsWith = (threadIds: string[], threadId: string) =>
  Array.from(new Set([...threadIds, threadId].filter(Boolean)));

const latestProposalPathFromThread = (thread: any) => {
  const metadata = isRecord(thread?.metadata) ? thread.metadata : {};
  const latestProposal = isRecord(metadata.latestProposal) ? metadata.latestProposal : undefined;
  if (typeof latestProposal?.path !== 'string') return undefined;
  try {
    return validateProposalPath(latestProposal.path);
  } catch {
    return undefined;
  }
};

const updateThreadProposalMetadata = async (context: any, snapshot: ReturnType<typeof proposalSnapshotFromFrontmatter>) => {
  const { threadId, memory, thread } = await getThreadRecord(context);
  const metadata = {
    ...(isRecord(thread.metadata) ? thread.metadata : {}),
    latestProposal: snapshot,
  };

  await (memory as any).updateThread({
    id: threadId,
    title: thread.title,
    metadata,
  });
};

const buildSnapshotOutput = (
  snapshot: ReturnType<typeof proposalSnapshotFromFrontmatter>,
  bytes?: number,
  extra: Record<string, unknown> = {},
) => ({
  ok: true,
  updated: true,
  ...snapshot,
  ...extra,
  ...(bytes !== undefined ? { bytes } : {}),
});

const resolveProposalPath = async (inputPath: string | undefined, context: any) => {
  if (inputPath) return validateProposalPath(inputPath);
  const { thread } = await getThreadRecord(context);
  const path = latestProposalPathFromThread(thread);
  if (!path) throw new Error('No proposalPath provided and this thread has no latest proposal artifact.');
  return path;
};

const proposalModelOutput = (name: string, output: unknown) => {
  const result = isRecord(output) ? output : {};
  const items = Array.isArray(result.items) ? result.items as Array<Record<string, unknown>> : [];
  const body = items.map((item, index) => {
    const id = typeof item.id === 'string' ? item.id : `item-${index + 1}`;
    const path = typeof item.path === 'string' ? ` ${item.path}` : '';
    return `${index + 1}. ${id} [${item.status ?? 'unknown'}]${path}`;
  }).join('\n');

  return formatToolModelOutput(name, [
    ['ok', result.ok],
    ['updated', result.updated],
    ['path', result.path],
    ['status', result.status],
    ['applied', result.applied],
    ['stale', result.stale],
    ['skipped', result.skipped],
    ['contentHash', result.contentHash],
    ['error', result.error],
  ], body);
};

const itemIdForPath = (path: string, index: number) =>
  `${path.replace(/[^a-zA-Z0-9._/-]+/g, '-').replace(/[/.]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'item'}-${index + 1}`.slice(0, 100);

export const writeProposalTool = createTool({
  id: 'write_proposal',
  description: [
    'Create a git-scoped proposed change artifact at .agents/proposals/<name>.md.',
    'Use this before mutating source files for Guided work: new features, significant refactors, migrations, schema changes, cross-cutting changes, risky or production-sensitive work, multi-file implementation, or work that already has an ExecPlan artifact.',
    'If a human confirms a Guided plan but no proposal exists, create the proposal instead of editing source files.',
    'Each file item must contain concrete proposed code hunks: provide unified diff hunk(s), or exact currentContent/proposedContent. Optional prose belongs in description or rationale, not in proposedContent.',
    'This tool only writes the proposal artifact. It does not apply proposed changes.',
  ].join('\n'),
  inputSchema: writeProposalInputSchema,
  outputSchema: proposalToolOutputSchema,
  execute: async (input, context) => {
    let path: string | undefined;
    try {
      await getGitProposalBinding(context);
      const { threadId } = await getThreadRecord(context);
      const proposalInput = writeProposalInputSchema.parse(input);
      const artifactPath = proposalInput.proposalPath ? validateProposalPath(proposalInput.proposalPath) : proposalPathForName(proposalInput.title);
      path = artifactPath;
      const now = new Date().toISOString();
      const items: ProposalItem[] = proposalInput.files.map((file, index) => {
        const diffCounts = countProposalChanges({
          kind: file.kind,
          diff: file.diff,
          currentContent: file.currentContent,
          proposedContent: file.proposedContent,
        });
        const currentContentHash = file.currentHash ?? (file.currentContent !== undefined ? hashText(file.currentContent) : undefined);
        const proposedContentHash = file.proposedContent !== undefined ? hashText(file.proposedContent) : undefined;
        return proposalItemSchema.parse({
          id: file.id ?? itemIdForPath(file.path, index),
          kind: file.kind,
          status: 'pending',
          title: file.title ?? file.path,
          path: file.path,
          additions: diffCounts.additions,
          deletions: diffCounts.deletions,
          viewed: false,
          current_hash: currentContentHash,
          proposed_hash: proposedContentHash,
        });
      });
      const frontmatter: ProposalFrontmatter = proposalFrontmatterSchema.parse({
        weave_proposal_version: 1,
        id: artifactPath.slice(proposalDirectory.length + 1, -'.md'.length),
        title: proposalInput.title.trim(),
        status: proposalInput.status ?? inferProposalStatus(items),
        scope: 'git',
        plan_path: proposalInput.planPath,
        thread_ids: [threadId],
        path: artifactPath,
        updated_at: now,
        summary: proposalInput.summary.trim(),
        items,
      });
      const body: ProposalBody = {
        overview: proposalInput.overview,
        items: proposalInput.files.map((file, index) => ({
          id: items[index].id,
          description: file.description,
          rationale: file.rationale,
          diff: file.diff,
          currentContent: file.currentContent,
          proposedContent: file.proposedContent,
        })),
      };
      assertProposalItemsCompleteForStatuses(items, body.items, ['pending', 'approved', 'applied']);
      const content = renderProposalArtifact(frontmatter, body);
      const write = await writePortalFile(artifactPath, content, context);
      if (!write.ok) return toolError(write.error, artifactPath);

      const snapshot = proposalSnapshotFromFrontmatter(frontmatter, content);
      const output = buildSnapshotOutput(snapshot, write.bytes);
      await updateThreadProposalMetadata(context, snapshot);
      return output;
    } catch (error) {
      return toolError(error, path);
    }
  },
  toModelOutput: output => proposalModelOutput('write_proposal', output),
});

const applyItemUpdates = (items: ProposalItem[], input: z.infer<typeof updateProposalInputSchema>) => {
  let next = items.map(item => ({ ...item }));
  if (input.approveAllPending) {
    next = next.map(item => item.status === 'pending' ? { ...item, status: 'approved' as const } : item);
  }
  if (input.approveAllViewed) {
    next = next.map(item => item.status === 'pending' && item.viewed ? { ...item, status: 'approved' as const } : item);
  }
  if (input.rejectAllPending) {
    next = next.map(item => item.status === 'pending' ? { ...item, status: 'rejected' as const } : item);
  }
  if (input.requestChanges) {
    next = next.map(item => item.status === 'pending' || item.status === 'approved'
      ? { ...item, status: 'changes_requested' as const, comment: input.requestChanges }
      : item);
  }

  for (const update of input.items ?? []) {
    const index = next.findIndex(item => item.id === update.id);
    if (index < 0) throw new Error(`Unknown proposal item id: ${update.id}`);
    next[index] = {
      ...next[index],
      ...(update.status ? { status: update.status } : {}),
      ...(typeof update.viewed === 'boolean' ? { viewed: update.viewed } : {}),
      ...(typeof update.comment === 'string' ? { comment: update.comment } : {}),
    };
  }
  return next;
};

export const updateProposalTool = createTool({
  id: 'update_proposal',
  description: 'Update approval, viewed, rejection, or request-changes state in a proposal artifact.',
  inputSchema: updateProposalInputSchema,
  outputSchema: proposalToolOutputSchema,
  execute: async (input, context) => {
    let path: string | undefined;
    try {
      await getGitProposalBinding(context);
      const { threadId } = await getThreadRecord(context);
      const artifactPath = await resolveProposalPath(input.proposalPath, context);
      path = artifactPath;
      const read = await readPortalFile(artifactPath, context);
      if (!read.ok) return toolError(read.error, artifactPath);

      const parsed = parseProposalArtifact(read.content);
      const now = new Date().toISOString();
      const items = applyItemUpdates(parsed.frontmatter.items, input);
      assertProposalItemsCompleteForStatuses(
        items,
        parsed.body.items,
        input.status === 'approved' || input.status === 'applied'
          ? ['pending', 'approved', 'applied']
          : ['approved', 'applied'],
      );
      const frontmatter = proposalFrontmatterSchema.parse({
        ...parsed.frontmatter,
        status: input.status ?? inferProposalStatus(items),
        thread_ids: threadIdsWith(parsed.frontmatter.thread_ids, threadId),
        updated_at: now,
        items,
      });
      const content = renderProposalArtifact(frontmatter, parsed.body);
      const write = await writePortalFile(artifactPath, content, context);
      if (!write.ok) return toolError(write.error, artifactPath);

      const snapshot = proposalSnapshotFromFrontmatter(frontmatter, content);
      const output = buildSnapshotOutput(snapshot, write.bytes);
      await updateThreadProposalMetadata(context, snapshot);
      return output;
    } catch (error) {
      return toolError(error, path);
    }
  },
  toModelOutput: output => proposalModelOutput('update_proposal', output),
});

export const __proposalToolTest = {
  writeProposalInputSchema,
  updateProposalInputSchema,
};
