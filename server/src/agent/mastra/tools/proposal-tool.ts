import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { isMissingPathError } from '../../../../../packages/client/src/lib/proposal-unified-diff';
import { formatToolModelOutput, getCodeToolModelOutputMaxChars, hashText } from './model-output';
import { summarizeProposalToolInput } from './proposal-tool-input-summary';
import { toolDescription, toolInputDescription } from './instructions';
import {
  assertProposalItemsCompleteForStatuses,
  countProposalChanges,
  inferProposalStatus,
  type ParsedProposalArtifact,
  parseProposalArtifact,
  type ProposalBody,
  type ProposalBodyItem,
  proposalDirectory,
  type ProposalFrontmatter,
  proposalFrontmatterSchema,
  type ProposalItem,
  type ProposalItemKind,
  proposalItemSchema,
  proposalItemStatusSchema,
  proposalPathForName,
  type ProposalSnapshot,
  proposalSnapshotFromFrontmatter,
  renderProposalArtifact,
  validateProposalPath,
} from './proposal-artifacts';
import { getThreadBinding, offlineMessage, routePortalTool } from './portal-tools';

const optionalString = (schema: z.ZodString = z.string()) => schema.nullish().transform((value) => value ?? undefined);

const isSingleProposalFilePath = (path: string) => {
  const trimmed = path.trim();
  if (!trimmed || trimmed !== path) return false;
  if (/[\r\n\0]/.test(path)) return false;
  if (/\s+and\s+/i.test(path)) return false;
  if (path.includes(',')) return false;
  return true;
};

const proposalFilePathSchema = z.string().min(1).refine(isSingleProposalFilePath, {
  message: 'path must identify exactly one source file; create separate proposal items for separate files',
});

const exactEditSchema = z.object({
  oldText: z.string().min(1).describe(
    toolInputDescription('proposal_edit', 'edits[].oldText'),
  ),
  newText: z.string().describe(toolInputDescription('proposal_edit', 'edits[].newText')),
}).strict();

const proposalStartInputSchema = z.object({
  title: z.string().min(1).max(180),
  summary: z.string().min(1).max(500),
  proposalPath: optionalString().describe(toolInputDescription('proposal_start', 'proposalPath')),
  planPath: optionalString().describe(toolInputDescription('proposal_start', 'planPath')),
  overview: optionalString(),
}).strict();

const proposalReadInputSchema = z.object({
  proposalPath: optionalString().describe(toolInputDescription('proposal_read', 'proposalPath')),
  path: proposalFilePathSchema,
  offset: z.number().int().min(1).optional().describe(toolInputDescription('proposal_read', 'offset')),
  limit: z.number().int().min(1).max(2000).optional().describe(toolInputDescription('proposal_read', 'limit')),
}).strict();

const proposalWriteInputSchema = z.object({
  proposalPath: optionalString().describe(toolInputDescription('proposal_write', 'proposalPath')),
  path: proposalFilePathSchema,
  content: z.string().describe(toolInputDescription('proposal_write', 'content')),
  title: optionalString(z.string().min(1).max(240)),
  description: optionalString().describe(toolInputDescription('proposal_write', 'description')),
  rationale: optionalString(),
}).strict();

const proposalEditInputSchema = z.object({
  proposalPath: optionalString().describe(toolInputDescription('proposal_edit', 'proposalPath')),
  path: proposalFilePathSchema,
  edits: z.array(exactEditSchema).min(1).max(120),
  title: optionalString(z.string().min(1).max(240)),
  description: optionalString(),
  rationale: optionalString(),
}).strict();

const proposalDeleteInputSchema = z.object({
  proposalPath: optionalString().describe(toolInputDescription('proposal_delete', 'proposalPath')),
  path: proposalFilePathSchema,
  title: optionalString(z.string().min(1).max(240)),
  description: optionalString(),
  rationale: optionalString(),
}).strict();

const proposalDiscardInputSchema = z.object({
  proposalPath: optionalString().describe(toolInputDescription('proposal_discard', 'proposalPath')),
  path: proposalFilePathSchema,
}).strict();

const proposalStatusInputSchema = z.object({
  proposalPath: optionalString().describe(toolInputDescription('proposal_status', 'proposalPath')),
}).strict();

const proposalFinalizeInputSchema = z.object({
  proposalPath: optionalString().describe(toolInputDescription('proposal_finalize', 'proposalPath')),
}).strict();

const proposalMarkInputSchema = z.object({
  proposalPath: optionalString().describe(toolInputDescription('proposal_mark', 'proposalPath')),
  items: z.array(
    z.object({
      id: z.string().min(1).max(100),
      status: proposalItemStatusSchema,
      comment: optionalString(),
    }).strict(),
  ).min(1).max(120),
}).strict();

const proposalToolOutputSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  updated: z.boolean(),
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
  source: z.enum(['proposal', 'live']).optional(),
  exists: z.boolean().optional(),
  deleted: z.boolean().optional(),
  offset: z.number().optional(),
  limit: z.number().optional(),
  totalLines: z.number().optional(),
  totalChars: z.number().optional(),
  returnedLines: z.number().optional(),
  currentHash: z.string().optional(),
  proposedHash: z.string().optional(),
  applied: z.number().optional(),
  stale: z.number().optional(),
  skipped: z.number().optional(),
  discarded: z.number().optional(),
  drift: z.array(z.string()).optional(),
}).strict();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const textByteLength = (value: string) => new TextEncoder().encode(value).byteLength;

const summarizeToolPayloadInput = ({ input }: { input?: unknown }) => summarizeProposalToolInput(input);

const payloadTextSummary = (value: unknown, prefix: string) => {
  if (typeof value !== 'string') return {};
  return {
    [`${prefix}Chars`]: value.length,
    [`${prefix}Hash`]: hashText(value),
  };
};

const summarizeToolPayloadOutput = ({ output }: { output?: unknown }) => {
  if (!isRecord(output)) return output;
  return {
    ok: output.ok,
    ...(typeof output.path === 'string' ? { path: output.path } : {}),
    ...(typeof output.status === 'string' ? { status: output.status } : {}),
    ...(typeof output.source === 'string' ? { source: output.source } : {}),
    ...(typeof output.deleted === 'boolean' ? { deleted: output.deleted } : {}),
    ...(typeof output.updated === 'boolean' ? { updated: output.updated } : {}),
    ...(typeof output.offset === 'number' ? { offset: output.offset } : {}),
    ...(typeof output.limit === 'number' ? { limit: output.limit } : {}),
    ...(typeof output.totalLines === 'number' ? { totalLines: output.totalLines } : {}),
    ...(typeof output.totalChars === 'number' ? { totalChars: output.totalChars } : {}),
    ...(typeof output.contentHash === 'string' ? { contentHash: output.contentHash } : {}),
    ...(typeof output.currentHash === 'string' ? { currentHash: output.currentHash } : {}),
    ...(typeof output.proposedHash === 'string' ? { proposedHash: output.proposedHash } : {}),
    ...(typeof output.error === 'string' ? { error: output.error } : {}),
    ...(Array.isArray(output.items) ? { items: output.items } : {}),
    ...(isRecord(output.counts) ? { counts: output.counts } : {}),
    ...payloadTextSummary(output.content, 'content'),
  };
};

const proposalToolTransform = {
  display: {
    input: summarizeToolPayloadInput,
    output: summarizeToolPayloadOutput,
  },
  transcript: {
    input: summarizeToolPayloadInput,
    output: summarizeToolPayloadOutput,
  },
};

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

const readWorkspaceTextFile = async (path: string, context: any) => {
  const result = await routePortalTool('portal.fs.read', { path }, context);
  const record = isRecord(result) ? result : {};
  if (record.ok === false) return { ok: false as const, error: portalError(result, `Unable to read ${path}`) };
  if (typeof record.content !== 'string') {
    return { ok: false as const, error: `Portal read returned no content for ${path}` };
  }
  return {
    ok: true as const,
    content: record.content,
    version: typeof record.version === 'string' ? record.version : undefined,
    size: typeof record.size === 'number' ? record.size : undefined,
  };
};

const readWorkspaceFileHash = async (path: string, context: any) => {
  const result = await routePortalTool('portal.fs.hash', { path }, context);
  const record = isRecord(result) ? result : {};
  if (record.ok === false) return { ok: false as const, error: portalError(result, `Unable to hash ${path}`) };
  if (typeof record.contentHash !== 'string') {
    return { ok: false as const, error: `Portal hash returned no contentHash for ${path}` };
  }
  return {
    ok: true as const,
    contentHash: record.contentHash,
    lineCount: typeof record.lineCount === 'number' ? record.lineCount : undefined,
    size: typeof record.size === 'number' ? record.size : undefined,
  };
};

const writeWorkspaceTextFile = async (path: string, content: string, context: any) => {
  const result = await routePortalTool('portal.fs.write', { path, content, createParents: true }, context);
  const record = isRecord(result) ? result : {};
  if (record.ok === false) return { ok: false as const, error: portalError(result, `Unable to write ${path}`) };
  return {
    ok: true as const,
    bytes: typeof record.size === 'number' ? record.size : textByteLength(content),
  };
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

const metadataProposalPath = (metadata: unknown, key: 'latestProposal' | 'latestProposalDraft') => {
  const record = isRecord(metadata) ? metadata : {};
  const proposal = isRecord(record[key]) ? record[key] : undefined;
  if (typeof proposal?.path !== 'string') return undefined;
  try {
    return validateProposalPath(proposal.path);
  } catch {
    return undefined;
  }
};

const latestProposalPathFromThread = (thread: any, preferDraft: boolean) => {
  const draft = metadataProposalPath(thread?.metadata, 'latestProposalDraft');
  const latest = metadataProposalPath(thread?.metadata, 'latestProposal');
  return preferDraft ? draft ?? latest : latest ?? draft;
};

const updateThreadProposalMetadata = async (
  context: any,
  snapshot: ProposalSnapshot,
  mode: 'draft' | 'finalized',
) => {
  const { threadId, memory, thread } = await getThreadRecord(context);
  const metadata = { ...(isRecord(thread.metadata) ? thread.metadata : {}) };

  if (mode === 'draft') {
    metadata.latestProposalDraft = snapshot;
    if (isRecord(metadata.latestProposal) && metadata.latestProposal.path === snapshot.path) {
      delete metadata.latestProposal;
    }
  } else {
    metadata.latestProposal = snapshot;
    if (isRecord(metadata.latestProposalDraft) && metadata.latestProposalDraft.path === snapshot.path) {
      delete metadata.latestProposalDraft;
    }
  }

  await (memory as any).updateThread({
    id: threadId,
    title: thread.title,
    metadata,
  });
};

const buildSnapshotOutput = (
  snapshot: ProposalSnapshot,
  bytes?: number,
  extra: Record<string, unknown> = {},
) => ({
  ok: true,
  updated: true,
  ...snapshot,
  ...extra,
  ...(bytes !== undefined ? { bytes } : {}),
});

const resolveProposalPath = async (
  inputPath: string | undefined,
  context: any,
  options: { preferDraft?: boolean } = {},
) => {
  if (inputPath) return validateProposalPath(inputPath);
  const { thread } = await getThreadRecord(context);
  const path = latestProposalPathFromThread(thread, options.preferDraft !== false);
  if (!path) {
    throw new Error(
      'No proposalPath provided and this thread has no active proposal artifact. Call proposal_start first.',
    );
  }
  return path;
};

const readProposalArtifactMaybe = async (artifactPath: string, context: any) => {
  const read = await readWorkspaceTextFile(artifactPath, context);
  if (!read.ok) {
    if (isMissingPathError(read.error)) return undefined;
    throw new Error(read.error);
  }
  return {
    content: read.content,
    parsed: parseProposalArtifact(read.content),
  };
};

const readProposalArtifactRequired = async (artifactPath: string, context: any) => {
  const artifact = await readProposalArtifactMaybe(artifactPath, context);
  if (!artifact) throw new Error(`Proposal artifact does not exist: ${artifactPath}. Call proposal_start first.`);
  return artifact;
};

const proposalModelOutput = (name: string, output: unknown) => {
  const result = isRecord(output) ? output : {};
  const items = Array.isArray(result.items) ? result.items as Array<Record<string, unknown>> : [];
  const body = items.map((item, index) => {
    const id = typeof item.id === 'string' ? item.id : `item-${index + 1}`;
    const path = typeof item.path === 'string' ? ` ${item.path}` : '';
    const comment = typeof item.comment === 'string' && item.comment.trim()
      ? ` comment: ${item.comment.trim().slice(0, 300)}`
      : '';
    return `${index + 1}. ${id} [${item.status ?? 'unknown'}]${path}${comment}`;
  }).join('\n');

  return formatToolModelOutput(name, [
    ['ok', result.ok],
    ['updated', result.updated],
    ['path', result.path],
    ['status', result.status],
    ['source', result.source],
    ['deleted', result.deleted],
    ['offset', result.offset],
    ['limit', result.limit],
    ['totalLines', result.totalLines],
    ['totalChars', result.totalChars],
    ['contentHash', result.contentHash],
    ['currentHash', result.currentHash],
    ['proposedHash', result.proposedHash],
    ['applied', result.applied],
    ['stale', result.stale],
    ['skipped', result.skipped],
    ['discarded', result.discarded],
    ['error', result.error],
  ], body);
};

const proposalReadModelOutput = (output: unknown, maxChars = getCodeToolModelOutputMaxChars()) => {
  const result = isRecord(output) ? output : {};
  return formatToolModelOutput(
    'proposal_read',
    [
      ['ok', result.ok],
      ['path', result.path],
      ['source', result.source],
      ['deleted', result.deleted],
      ['offset', result.offset],
      ['limit', result.limit],
      ['totalLines', result.totalLines],
      ['totalChars', result.totalChars],
      ['contentHash', result.contentHash],
      ['currentHash', result.currentHash],
      ['proposedHash', result.proposedHash],
      ['error', result.error],
    ],
    result.content,
    maxChars,
  );
};

const itemIdForPath = (path: string) =>
  (path.replace(/[^a-zA-Z0-9._/-]+/g, '-').replace(/[/.]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'item')
    .slice(0, 96);

const codeProposalItemKinds = new Set<ProposalItemKind>(['file_edit', 'file_create', 'file_delete']);

const findFileItemIndex = (items: ProposalItem[], path: string) =>
  items.findIndex((item) => codeProposalItemKinds.has(item.kind) && item.path === path);

const bodyItemById = (body: ProposalBody, id: string) => body.items.find((item) => item.id === id);

const countTextLines = (content: string) => {
  if (!content) return 0;
  return content.endsWith('\n') ? content.slice(0, -1).split('\n').length : content.split('\n').length;
};

const paginateContent = (content: string, offset = 1, limit?: number) => {
  const totalLines = countTextLines(content);
  const totalChars = content.length;
  if (!content) {
    return { content: '', offset, limit, totalLines, totalChars, returnedLines: 0 };
  }

  const lines = content.split('\n');
  if (offset > lines.length) throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines total)`);
  const startIndex = offset - 1;
  const endIndex = limit ? Math.min(startIndex + limit, lines.length) : lines.length;
  const selected = lines.slice(startIndex, endIndex).join('\n');
  return {
    content: selected,
    offset,
    ...(limit !== undefined ? { limit } : {}),
    totalLines,
    totalChars,
    returnedLines: countTextLines(selected),
  };
};

const assertBodyHashesMatchItem = (item: ProposalItem, bodyItem: ProposalBodyItem | undefined) => {
  if (!bodyItem) throw new Error(`Proposal item ${item.id} is missing its body section.`);
  if (
    item.current_hash && typeof bodyItem.currentContent === 'string' &&
    hashText(bodyItem.currentContent) !== item.current_hash
  ) {
    throw new Error(
      `Proposal item ${item.id} has stale current content; current_hash does not match the stored buffer.`,
    );
  }
  if (
    item.proposed_hash && typeof bodyItem.proposedContent === 'string' &&
    hashText(bodyItem.proposedContent) !== item.proposed_hash
  ) {
    throw new Error(
      `Proposal item ${item.id} has stale proposed content; proposed_hash does not match the stored buffer.`,
    );
  }
};

type VirtualFileState = {
  source: 'proposal' | 'live';
  kind: 'file_edit' | 'file_create' | 'file_delete';
  currentContent?: string;
  currentHash?: string;
  proposedContent?: string;
  proposedHash?: string;
  item?: ProposalItem;
  bodyItem?: ProposalBodyItem;
  deleted: boolean;
};

const getVirtualFileState = async (
  parsed: ParsedProposalArtifact,
  path: string,
  context: any,
): Promise<VirtualFileState> => {
  const itemIndex = findFileItemIndex(parsed.frontmatter.items, path);
  if (itemIndex >= 0) {
    const item = parsed.frontmatter.items[itemIndex];
    const bodyItem = bodyItemById(parsed.body, item.id);
    assertBodyHashesMatchItem(item, bodyItem);

    if (item.kind === 'file_delete') {
      return {
        source: 'proposal',
        kind: 'file_delete',
        currentContent: bodyItem?.currentContent,
        currentHash: item.current_hash,
        item,
        bodyItem,
        deleted: true,
      };
    }

    if (item.kind === 'file_create') {
      if (typeof bodyItem?.proposedContent !== 'string') {
        throw new Error(`Proposal item ${item.id} is missing Proposed Content.`);
      }
      return {
        source: 'proposal',
        kind: 'file_create',
        proposedContent: bodyItem.proposedContent,
        proposedHash: item.proposed_hash,
        item,
        bodyItem,
        deleted: false,
      };
    }

    if (typeof bodyItem?.currentContent !== 'string') {
      throw new Error(`Proposal item ${item.id} is missing Current Content.`);
    }
    if (typeof bodyItem.proposedContent !== 'string') {
      throw new Error(`Proposal item ${item.id} is missing Proposed Content.`);
    }
    return {
      source: 'proposal',
      kind: 'file_edit',
      currentContent: bodyItem.currentContent,
      currentHash: item.current_hash,
      proposedContent: bodyItem.proposedContent,
      proposedHash: item.proposed_hash,
      item,
      bodyItem,
      deleted: false,
    };
  }

  const live = await readWorkspaceTextFile(path, context);
  if (!live.ok) throw new Error(live.error);
  const hash = await readWorkspaceFileHash(path, context);
  if (!hash.ok) throw new Error(hash.error);
  return {
    source: 'live',
    kind: 'file_edit',
    currentContent: live.content,
    currentHash: hash.contentHash,
    proposedContent: live.content,
    proposedHash: hash.contentHash,
    deleted: false,
  };
};

const readLiveFileMaybe = async (path: string, context: any) => {
  const live = await readWorkspaceTextFile(path, context);
  if (!live.ok) {
    if (isMissingPathError(live.error)) return undefined;
    throw new Error(live.error);
  }
  const hash = await readWorkspaceFileHash(path, context);
  if (!hash.ok) throw new Error(hash.error);
  return { content: live.content, hash: hash.contentHash };
};

type UpsertFileItemInput = {
  path: string;
  kind: 'file_edit' | 'file_create' | 'file_delete';
  currentContent?: string;
  proposedContent?: string;
  title?: string;
  description?: string;
  rationale?: string;
};

const upsertFileItem = (
  parsed: ParsedProposalArtifact,
  input: UpsertFileItemInput,
  threadId: string,
) => {
  const existingIndex = findFileItemIndex(parsed.frontmatter.items, input.path);
  const existingItem = existingIndex >= 0 ? parsed.frontmatter.items[existingIndex] : undefined;
  const existingBody = existingItem ? bodyItemById(parsed.body, existingItem.id) : undefined;
  const removedIds = new Set(
    parsed.frontmatter.items
      .filter((item) => codeProposalItemKinds.has(item.kind) && item.path === input.path)
      .map((item) => item.id),
  );
  const id = existingItem?.id ?? itemIdForPath(input.path);
  const currentHash = input.currentContent !== undefined ? hashText(input.currentContent) : undefined;
  const proposedHash = input.proposedContent !== undefined ? hashText(input.proposedContent) : undefined;
  const counts = countProposalChanges({
    kind: input.kind,
    currentContent: input.currentContent,
    proposedContent: input.proposedContent,
  });

  const item = proposalItemSchema.parse({
    id,
    kind: input.kind,
    status: 'pending',
    title: input.title ?? existingItem?.title ?? input.path,
    path: input.path,
    additions: counts.additions,
    deletions: counts.deletions,
    viewed: false,
    current_hash: currentHash,
    proposed_hash: proposedHash,
  });
  const bodyItem: ProposalBodyItem = {
    id,
    description: input.description ?? existingBody?.description,
    rationale: input.rationale ?? existingBody?.rationale,
    ...(input.currentContent !== undefined ? { currentContent: input.currentContent } : {}),
    ...(input.proposedContent !== undefined ? { proposedContent: input.proposedContent } : {}),
  };

  const remainingItems = parsed.frontmatter.items.filter((item) => !removedIds.has(item.id));
  const insertIndex = existingIndex >= 0 ? existingIndex : remainingItems.length;
  remainingItems.splice(insertIndex, 0, item);
  const remainingBodyItems = parsed.body.items.filter((body) => !removedIds.has(body.id));
  remainingBodyItems.splice(insertIndex, 0, bodyItem);

  const now = new Date().toISOString();
  const frontmatter = proposalFrontmatterSchema.parse({
    ...parsed.frontmatter,
    status: 'draft',
    thread_ids: threadIdsWith(parsed.frontmatter.thread_ids, threadId),
    updated_at: now,
    items: remainingItems,
  });
  const body: ProposalBody = {
    overview: parsed.body.overview,
    items: remainingBodyItems,
  };
  const content = renderProposalArtifact(frontmatter, body);
  return { frontmatter, body, content, item };
};

type DraftWriteOptions = {
  resetItemIds?: Set<string>;
  removeItemIds?: Set<string>;
};

const mergeDraftArtifact = (
  next: ParsedProposalArtifact,
  latest: ParsedProposalArtifact | undefined,
  options: DraftWriteOptions,
) => {
  if (!latest) return next;

  const nextItemsById = new Map(next.frontmatter.items.map((item) => [item.id, item]));
  const nextBodyById = new Map(next.body.items.map((item) => [item.id, item]));
  const latestBodyById = new Map(latest.body.items.map((item) => [item.id, item]));
  const resetItemIds = options.resetItemIds ?? new Set<string>();
  const removeItemIds = options.removeItemIds ?? new Set<string>();
  const mergedItems: ProposalItem[] = [];
  const mergedBodyItems: ProposalBodyItem[] = [];
  const addedIds = new Set<string>();

  const addItem = (item: ProposalItem, bodyItem: ProposalBodyItem | undefined) => {
    if (removeItemIds.has(item.id) || addedIds.has(item.id)) return;
    mergedItems.push(item);
    if (bodyItem) mergedBodyItems.push(bodyItem);
    addedIds.add(item.id);
  };

  for (const latestItem of latest.frontmatter.items) {
    const nextItem = nextItemsById.get(latestItem.id);
    if (nextItem && resetItemIds.has(latestItem.id)) {
      addItem(nextItem, nextBodyById.get(latestItem.id));
      continue;
    }
    addItem(latestItem, latestBodyById.get(latestItem.id));
  }

  for (const nextItem of next.frontmatter.items) {
    addItem(nextItem, nextBodyById.get(nextItem.id));
  }

  return {
    frontmatter: proposalFrontmatterSchema.parse({
      ...next.frontmatter,
      items: mergedItems,
    }),
    body: {
      overview: next.body.overview,
      items: mergedBodyItems,
    },
    rawBody: next.rawBody,
  };
};

const rebaseDraftArtifact = async (
  artifactPath: string,
  next: ParsedProposalArtifact,
  context: any,
  options: DraftWriteOptions,
) => mergeDraftArtifact(next, (await readProposalArtifactMaybe(artifactPath, context))?.parsed, options);

const writeDraftArtifact = async (
  context: any,
  artifactPath: string,
  content: string,
  options: DraftWriteOptions = {},
) => {
  const rebased = await rebaseDraftArtifact(artifactPath, parseProposalArtifact(content), context, options);
  const nextContent = renderProposalArtifact(rebased.frontmatter, rebased.body);
  const write = await writeWorkspaceTextFile(artifactPath, nextContent, context);
  if (!write.ok) throw new Error(write.error);
  const snapshot = proposalSnapshotFromFrontmatter(rebased.frontmatter, nextContent);
  await updateThreadProposalMetadata(context, snapshot, 'draft');
  return buildSnapshotOutput(snapshot, write.bytes);
};

const exactReplacementRanges = (content: string, edits: Array<z.infer<typeof exactEditSchema>>) => {
  const ranges = edits.map((edit, index) => {
    const first = content.indexOf(edit.oldText);
    if (first < 0) throw new Error(`edits[${index}].oldText was not found in the proposed buffer.`);
    if (content.indexOf(edit.oldText, first + edit.oldText.length) >= 0) {
      throw new Error(
        `edits[${index}].oldText matches more than once in the proposed buffer; make the oldText more specific.`,
      );
    }
    return {
      index,
      start: first,
      end: first + edit.oldText.length,
      oldText: edit.oldText,
      newText: edit.newText,
    };
  }).sort((left, right) => left.start - right.start);

  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) {
      throw new Error(
        `edits[${ranges[index].index}] overlaps edits[${ranges[index - 1].index}]. Merge nearby changes into one edit.`,
      );
    }
  }
  return ranges;
};

const applyExactReplacements = (content: string, edits: Array<z.infer<typeof exactEditSchema>>) => {
  const ranges = exactReplacementRanges(content, edits);
  let next = content;
  for (const range of [...ranges].reverse()) {
    next = `${next.slice(0, range.start)}${range.newText}${next.slice(range.end)}`;
  }
  return next;
};

const validateProposalForFinalize = async (
  frontmatter: ProposalFrontmatter,
  body: ProposalBody,
  context: any,
  deps: { readHash?: typeof readWorkspaceFileHash } = {},
) => {
  const readHash = deps.readHash ?? readWorkspaceFileHash;
  if (frontmatter.items.length === 0) {
    throw new Error('Cannot finalize an empty proposal. Add at least one file item first.');
  }
  assertProposalItemsCompleteForStatuses(
    frontmatter.items,
    body.items,
    ['pending', 'approved', 'applied', 'changes_requested', 'rejected', 'stale'],
  );

  const bodyById = new Map(body.items.map((item) => [item.id, item]));
  const drift: string[] = [];
  for (const item of frontmatter.items) {
    if (!codeProposalItemKinds.has(item.kind)) continue;
    if (!item.path) {
      drift.push(`${item.id}: missing path`);
      continue;
    }
    const bodyItem = bodyById.get(item.id);
    try {
      assertBodyHashesMatchItem(item, bodyItem);
    } catch (error) {
      drift.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (item.kind === 'file_edit') {
      if (typeof bodyItem?.currentContent !== 'string' || typeof bodyItem.proposedContent !== 'string') {
        drift.push(`${item.path}: file_edit items must contain Current Content and Proposed Content buffers.`);
        continue;
      }
    }
    if (item.kind === 'file_create' && typeof bodyItem?.proposedContent !== 'string') {
      drift.push(`${item.path}: file_create items must contain Proposed Content.`);
      continue;
    }
    if (item.kind === 'file_delete' && typeof bodyItem?.currentContent !== 'string') {
      drift.push(`${item.path}: file_delete items must contain Current Content.`);
      continue;
    }

    if (item.kind === 'file_create') {
      const liveHash = await readHash(item.path, context);
      if (liveHash.ok) {
        drift.push(`${item.path}: target now exists on disk; recreate this proposal item as an edit.`);
      } else if (!isMissingPathError(liveHash.error)) {
        drift.push(`${item.path}: ${liveHash.error}`);
      }
      continue;
    }

    const liveHash = await readHash(item.path, context);
    if (!liveHash.ok) {
      drift.push(`${item.path}: source file is missing on disk.`);
      continue;
    }
    if (item.current_hash && liveHash.contentHash !== item.current_hash) {
      drift.push(`${item.path}: source changed on disk (expected ${item.current_hash}, got ${liveHash.contentHash}).`);
    }
  }

  if (drift.length) {
    throw new Error(`Proposal cannot be finalized because file state drifted. ${drift.slice(0, 5).join(' ')}`);
  }
};

export const proposalStartTool = createTool({
  id: 'proposal_start',
  strict: true,
  description: toolDescription('proposal_start'),
  inputSchema: proposalStartInputSchema,
  outputSchema: proposalToolOutputSchema,
  transform: proposalToolTransform,
  execute: async (input, context) => {
    let path: string | undefined;
    try {
      await getGitProposalBinding(context);
      const { threadId } = await getThreadRecord(context);
      const proposalInput = proposalStartInputSchema.parse(input);
      const artifactPath = proposalInput.proposalPath
        ? validateProposalPath(proposalInput.proposalPath)
        : proposalPathForName(proposalInput.title);
      path = artifactPath;
      const existing = await readProposalArtifactMaybe(artifactPath, context);
      const now = new Date().toISOString();
      const frontmatter = proposalFrontmatterSchema.parse({
        weave_proposal_version: 1,
        id: artifactPath.slice(proposalDirectory.length + 1, -'.md'.length),
        title: proposalInput.title.trim(),
        status: 'draft',
        scope: 'git',
        plan_path: proposalInput.planPath ?? existing?.parsed.frontmatter.plan_path,
        thread_ids: threadIdsWith(existing?.parsed.frontmatter.thread_ids ?? [], threadId),
        path: artifactPath,
        updated_at: now,
        summary: proposalInput.summary.trim(),
        items: existing?.parsed.frontmatter.items ?? [],
      });
      const body: ProposalBody = {
        overview: proposalInput.overview ?? existing?.parsed.body.overview,
        items: existing?.parsed.body.items ?? [],
      };
      const content = renderProposalArtifact(frontmatter, body);
      return await writeDraftArtifact(context, artifactPath, content);
    } catch (error) {
      return toolError(error, path);
    }
  },
  toModelOutput: (output) => proposalModelOutput('proposal_start', output),
});

export const proposalReadTool = createTool({
  id: 'proposal_read',
  strict: true,
  description: toolDescription('proposal_read'),
  inputSchema: proposalReadInputSchema,
  outputSchema: proposalToolOutputSchema.extend({ content: z.string().optional() }).strict(),
  transform: proposalToolTransform,
  execute: async (input, context) => {
    let path: string | undefined;
    try {
      await getGitProposalBinding(context);
      const proposalInput = proposalReadInputSchema.parse(input);
      path = proposalInput.path;
      const artifactPath = await resolveProposalPath(proposalInput.proposalPath, context, { preferDraft: true });
      const { parsed } = await readProposalArtifactRequired(artifactPath, context);
      const state = await getVirtualFileState(parsed, proposalInput.path, context);
      if (state.deleted) {
        return {
          ok: true,
          updated: false,
          path: proposalInput.path,
          source: 'proposal' as const,
          exists: false,
          deleted: true,
          content: '',
          contentHash: state.currentHash,
          currentHash: state.currentHash,
          totalLines: 0,
          totalChars: 0,
          returnedLines: 0,
          offset: proposalInput.offset ?? 1,
          ...(proposalInput.limit !== undefined ? { limit: proposalInput.limit } : {}),
        };
      }

      const content = state.proposedContent ?? '';
      return {
        ok: true,
        updated: false,
        path: proposalInput.path,
        source: state.source,
        exists: true,
        deleted: false,
        contentHash: state.proposedHash ?? hashText(content),
        currentHash: state.currentHash,
        proposedHash: state.proposedHash ?? hashText(content),
        ...paginateContent(content, proposalInput.offset ?? 1, proposalInput.limit),
      };
    } catch (error) {
      return toolError(error, path);
    }
  },
  toModelOutput: proposalReadModelOutput,
});

export const proposalWriteTool = createTool({
  id: 'proposal_write',
  strict: true,
  description: toolDescription('proposal_write'),
  inputSchema: proposalWriteInputSchema,
  outputSchema: proposalToolOutputSchema,
  transform: proposalToolTransform,
  execute: async (input, context) => {
    let path: string | undefined;
    try {
      await getGitProposalBinding(context);
      const { threadId } = await getThreadRecord(context);
      const proposalInput = proposalWriteInputSchema.parse(input);
      path = proposalInput.path;
      const artifactPath = await resolveProposalPath(proposalInput.proposalPath, context, { preferDraft: true });
      const { parsed } = await readProposalArtifactRequired(artifactPath, context);
      const existingState = findFileItemIndex(parsed.frontmatter.items, proposalInput.path) >= 0
        ? await getVirtualFileState(parsed, proposalInput.path, context)
        : undefined;
      const live = existingState ? undefined : await readLiveFileMaybe(proposalInput.path, context);
      const kind = existingState?.kind === 'file_create' || !existingState && !live ? 'file_create' : 'file_edit';
      const currentContent = kind === 'file_create' ? undefined : existingState?.currentContent ?? live?.content;
      const { content, item } = upsertFileItem(parsed, {
        path: proposalInput.path,
        kind,
        currentContent,
        proposedContent: proposalInput.content,
        title: proposalInput.title,
        description: proposalInput.description,
        rationale: proposalInput.rationale,
      }, threadId);
      return await writeDraftArtifact(context, artifactPath, content, { resetItemIds: new Set([item.id]) });
    } catch (error) {
      return toolError(error, path);
    }
  },
  toModelOutput: (output) => proposalModelOutput('proposal_write', output),
});

export const proposalEditTool = createTool({
  id: 'proposal_edit',
  strict: true,
  description: toolDescription('proposal_edit'),
  inputSchema: proposalEditInputSchema,
  outputSchema: proposalToolOutputSchema,
  transform: proposalToolTransform,
  execute: async (input, context) => {
    let path: string | undefined;
    try {
      await getGitProposalBinding(context);
      const { threadId } = await getThreadRecord(context);
      const proposalInput = proposalEditInputSchema.parse(input);
      path = proposalInput.path;
      const artifactPath = await resolveProposalPath(proposalInput.proposalPath, context, { preferDraft: true });
      const { parsed } = await readProposalArtifactRequired(artifactPath, context);
      const state = await getVirtualFileState(parsed, proposalInput.path, context);
      if (state.deleted) {
        throw new Error(
          `${proposalInput.path} is currently proposed for deletion. Use proposal_write to replace it with content or proposal_discard to remove the item.`,
        );
      }
      const original = state.proposedContent ?? '';
      const next = applyExactReplacements(original, proposalInput.edits);
      const kind = state.kind === 'file_create' ? 'file_create' : 'file_edit';
      const { content, item } = upsertFileItem(parsed, {
        path: proposalInput.path,
        kind,
        currentContent: kind === 'file_create' ? undefined : state.currentContent,
        proposedContent: next,
        title: proposalInput.title,
        description: proposalInput.description,
        rationale: proposalInput.rationale,
      }, threadId);
      return await writeDraftArtifact(context, artifactPath, content, { resetItemIds: new Set([item.id]) });
    } catch (error) {
      return toolError(error, path);
    }
  },
  toModelOutput: (output) => proposalModelOutput('proposal_edit', output),
});

export const proposalDeleteTool = createTool({
  id: 'proposal_delete',
  strict: true,
  description: toolDescription('proposal_delete'),
  inputSchema: proposalDeleteInputSchema,
  outputSchema: proposalToolOutputSchema,
  transform: proposalToolTransform,
  execute: async (input, context) => {
    let path: string | undefined;
    try {
      await getGitProposalBinding(context);
      const { threadId } = await getThreadRecord(context);
      const proposalInput = proposalDeleteInputSchema.parse(input);
      path = proposalInput.path;
      const artifactPath = await resolveProposalPath(proposalInput.proposalPath, context, { preferDraft: true });
      const { parsed } = await readProposalArtifactRequired(artifactPath, context);
      const itemIndex = findFileItemIndex(parsed.frontmatter.items, proposalInput.path);
      const state = itemIndex >= 0 ? await getVirtualFileState(parsed, proposalInput.path, context) : undefined;
      if (state?.kind === 'file_create') {
        throw new Error(
          `${proposalInput.path} only exists as a proposed create. Use proposal_discard to remove that proposal item.`,
        );
      }
      const live = state ? undefined : await readLiveFileMaybe(proposalInput.path, context);
      if (!state && !live) {
        throw new Error(`${proposalInput.path} does not exist on disk, so it cannot be proposed for deletion.`);
      }
      const currentContent = state?.currentContent ?? live?.content;
      if (currentContent === undefined) {
        throw new Error(`${proposalInput.path} has no current content snapshot to delete.`);
      }
      const { content, item } = upsertFileItem(parsed, {
        path: proposalInput.path,
        kind: 'file_delete',
        currentContent,
        title: proposalInput.title,
        description: proposalInput.description,
        rationale: proposalInput.rationale,
      }, threadId);
      return await writeDraftArtifact(context, artifactPath, content, { resetItemIds: new Set([item.id]) });
    } catch (error) {
      return toolError(error, path);
    }
  },
  toModelOutput: (output) => proposalModelOutput('proposal_delete', output),
});

export const proposalDiscardTool = createTool({
  id: 'proposal_discard',
  strict: true,
  description: toolDescription('proposal_discard'),
  inputSchema: proposalDiscardInputSchema,
  outputSchema: proposalToolOutputSchema,
  transform: proposalToolTransform,
  execute: async (input, context) => {
    let path: string | undefined;
    try {
      await getGitProposalBinding(context);
      const { threadId } = await getThreadRecord(context);
      const proposalInput = proposalDiscardInputSchema.parse(input);
      path = proposalInput.path;
      const artifactPath = await resolveProposalPath(proposalInput.proposalPath, context, { preferDraft: true });
      const { parsed } = await readProposalArtifactRequired(artifactPath, context);
      const removedIds = new Set(
        parsed.frontmatter.items
          .filter((item) => codeProposalItemKinds.has(item.kind) && item.path === proposalInput.path)
          .map((item) => item.id),
      );
      if (!removedIds.size) {
        const snapshot = proposalSnapshotFromFrontmatter(
          parsed.frontmatter,
          renderProposalArtifact(parsed.frontmatter, parsed.body),
        );
        return { ok: true, updated: false, ...snapshot, discarded: 0 };
      }
      const frontmatter = proposalFrontmatterSchema.parse({
        ...parsed.frontmatter,
        status: 'draft',
        thread_ids: threadIdsWith(parsed.frontmatter.thread_ids, threadId),
        updated_at: new Date().toISOString(),
        items: parsed.frontmatter.items.filter((item) => !removedIds.has(item.id)),
      });
      const body = {
        overview: parsed.body.overview,
        items: parsed.body.items.filter((item) => !removedIds.has(item.id)),
      };
      const content = renderProposalArtifact(frontmatter, body);
      const output = await writeDraftArtifact(context, artifactPath, content, { removeItemIds: removedIds });
      return { ...output, discarded: removedIds.size };
    } catch (error) {
      return toolError(error, path);
    }
  },
  toModelOutput: (output) => proposalModelOutput('proposal_discard', output),
});

export const proposalStatusTool = createTool({
  id: 'proposal_status',
  strict: true,
  description: toolDescription('proposal_status'),
  inputSchema: proposalStatusInputSchema,
  outputSchema: proposalToolOutputSchema,
  transform: proposalToolTransform,
  execute: async (input, context) => {
    let path: string | undefined;
    try {
      await getGitProposalBinding(context);
      const proposalInput = proposalStatusInputSchema.parse(input);
      const artifactPath = await resolveProposalPath(proposalInput.proposalPath, context, { preferDraft: true });
      path = artifactPath;
      const { parsed, content } = await readProposalArtifactRequired(artifactPath, context);
      return {
        ok: true,
        updated: false,
        ...proposalSnapshotFromFrontmatter(parsed.frontmatter, content),
      };
    } catch (error) {
      return toolError(error, path);
    }
  },
  toModelOutput: (output) => proposalModelOutput('proposal_status', output),
});

export const proposalFinalizeTool = createTool({
  id: 'proposal_finalize',
  strict: true,
  description: toolDescription('proposal_finalize'),
  inputSchema: proposalFinalizeInputSchema,
  outputSchema: proposalToolOutputSchema,
  transform: proposalToolTransform,
  execute: async (input, context) => {
    let path: string | undefined;
    try {
      await getGitProposalBinding(context);
      const { threadId } = await getThreadRecord(context);
      const proposalInput = proposalFinalizeInputSchema.parse(input);
      const artifactPath = await resolveProposalPath(proposalInput.proposalPath, context, { preferDraft: true });
      path = artifactPath;
      const { parsed } = await readProposalArtifactRequired(artifactPath, context);
      await validateProposalForFinalize(parsed.frontmatter, parsed.body, context);
      const frontmatter = proposalFrontmatterSchema.parse({
        ...parsed.frontmatter,
        status: inferProposalStatus(parsed.frontmatter.items),
        thread_ids: threadIdsWith(parsed.frontmatter.thread_ids, threadId),
        updated_at: new Date().toISOString(),
      });
      const content = renderProposalArtifact(frontmatter, parsed.body);
      const write = await writeWorkspaceTextFile(artifactPath, content, context);
      if (!write.ok) throw new Error(write.error);
      const snapshot = proposalSnapshotFromFrontmatter(frontmatter, content);
      await updateThreadProposalMetadata(context, snapshot, 'finalized');
      return buildSnapshotOutput(snapshot, write.bytes);
    } catch (error) {
      return toolError(error, path);
    }
  },
  toModelOutput: (output) => proposalModelOutput('proposal_finalize', output),
});

export const proposalMarkTool = createTool({
  id: 'proposal_mark',
  strict: true,
  description: toolDescription('proposal_mark'),
  inputSchema: proposalMarkInputSchema,
  outputSchema: proposalToolOutputSchema,
  transform: proposalToolTransform,
  execute: async (input, context) => {
    let path: string | undefined;
    try {
      await getGitProposalBinding(context);
      const { threadId } = await getThreadRecord(context);
      const proposalInput = proposalMarkInputSchema.parse(input);
      const artifactPath = await resolveProposalPath(proposalInput.proposalPath, context, { preferDraft: false });
      path = artifactPath;
      const { parsed } = await readProposalArtifactRequired(artifactPath, context);
      const updatesById = new Map(proposalInput.items.map((item) => [item.id, item]));
      let applied = 0;
      let stale = 0;
      let skipped = 0;
      const items = parsed.frontmatter.items.map((item) => {
        const update = updatesById.get(item.id);
        if (!update) return item;
        updatesById.delete(item.id);
        if (update.status === item.status && update.comment === undefined) {
          skipped += 1;
          return item;
        }
        if (update.status === 'applied') applied += 1;
        if (update.status === 'stale') stale += 1;
        return {
          ...item,
          status: update.status,
          viewed: update.status === 'approved' || update.status === 'applied' ? true : item.viewed,
          ...(update.comment !== undefined ? { comment: update.comment } : {}),
          ...(update.status === 'applied' ? { applied_at: new Date().toISOString() } : {}),
        };
      });
      const unknown = [...updatesById.keys()];
      if (unknown.length) throw new Error(`Unknown proposal item id(s): ${unknown.join(', ')}`);
      assertProposalItemsCompleteForStatuses(items, parsed.body.items, ['pending', 'approved', 'applied']);
      const frontmatter = proposalFrontmatterSchema.parse({
        ...parsed.frontmatter,
        status: parsed.frontmatter.status === 'draft' ? 'draft' : inferProposalStatus(items),
        thread_ids: threadIdsWith(parsed.frontmatter.thread_ids, threadId),
        updated_at: new Date().toISOString(),
        items,
      });
      const content = renderProposalArtifact(frontmatter, parsed.body);
      const write = await writeWorkspaceTextFile(artifactPath, content, context);
      if (!write.ok) throw new Error(write.error);
      const snapshot = proposalSnapshotFromFrontmatter(frontmatter, content);
      await updateThreadProposalMetadata(context, snapshot, frontmatter.status === 'draft' ? 'draft' : 'finalized');
      return buildSnapshotOutput(snapshot, write.bytes, { applied, stale, skipped });
    } catch (error) {
      return toolError(error, path);
    }
  },
  toModelOutput: (output) => proposalModelOutput('proposal_mark', output),
});

export const __proposalToolTest = {
  applyExactReplacements,
  exactEditSchema,
  isSingleProposalFilePath,
  itemIdForPath,
  mergeDraftArtifact,
  paginateContent,
  proposalModelOutput,
  proposalDeleteInputSchema,
  proposalDiscardInputSchema,
  proposalEditInputSchema,
  proposalFinalizeInputSchema,
  proposalMarkInputSchema,
  proposalReadInputSchema,
  proposalStartInputSchema,
  proposalStatusInputSchema,
  proposalWriteInputSchema,
  validateProposalForFinalize,
};
