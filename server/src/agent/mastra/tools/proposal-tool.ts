import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  applyUnifiedDiff,
  countUnifiedDiffChanges,
  isLikelyProseUnifiedDiff,
  isMissingPathError,
  parseUnifiedDiff,
  splitUnifiedDiffByFile,
} from '../../../../../packages/client/src/lib/proposal-unified-diff';
import { formatToolModelOutput, hashText } from './model-output';
import { summarizeProposalToolInput } from './proposal-tool-input-summary';
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
const writeProposalStatusSchema = z.enum(['draft', 'ready']);
const updateProposalStatusSchema = z.enum([
  'draft',
  'ready',
  'partially_approved',
  'approved',
  'changes_requested',
  'applied',
  'rejected',
  'stale',
]);

const optionalString = (schema: z.ZodString = z.string()) =>
  schema.nullish().transform(value => value ?? undefined);

const optionalWriteProposalStatus = writeProposalStatusSchema.nullish().transform(value => value ?? undefined);
const optionalUpdateProposalStatus = updateProposalStatusSchema.nullish().transform(value => value ?? undefined);

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

const proposalFileInputSchema = z.object({
  id: optionalString(z.string().min(1).max(100)),
  kind: proposalCodeItemKindSchema.default('file_edit'),
  title: optionalString(z.string().min(1).max(240)),
  path: proposalFilePathSchema,
  description: optionalString().describe('Optional human-readable description of this item. Do not put proposed code here.'),
  rationale: optionalString(),
  diff: optionalString().describe('Concrete unified diff hunk(s) for file_edit, or create-style hunks for file_create. Do not put prose here.'),
  currentContent: optionalString().describe('Legacy compatibility only. New file_edit and file_delete proposals ignore this field.'),
  proposedContent: optionalString().describe('Required for file_create unless a create-style diff is provided. Ignored for file_edit.'),
  currentHash: optionalString().describe('Legacy compatibility only. The tool computes current hashes from the repository.'),
}).strict();

const writeProposalInputSchema = z.object({
  title: z.string().min(1).max(180),
  summary: z.string().min(1).max(500),
  proposalPath: optionalString().describe(`Optional artifact path. Must be ${proposalDirectory}/<name>.md.`),
  planPath: optionalString().describe('Optional linked plan artifact path.'),
  status: optionalWriteProposalStatus,
  overview: optionalString(),
  files: z.array(proposalFileInputSchema).min(1).max(120),
}).strict();

const proposalPatchFileMetadataSchema = z.object({
  id: optionalString(z.string().min(1).max(100)),
  path: proposalFilePathSchema,
  title: optionalString(z.string().min(1).max(240)),
  description: optionalString().describe('Optional human-readable description of this item. Do not put proposed code here.'),
  rationale: optionalString(),
}).strict();

const writeProposalPatchInputSchema = z.object({
  title: z.string().min(1).max(180),
  summary: z.string().min(1).max(500),
  proposalPath: optionalString().describe(`Optional artifact path. Must be ${proposalDirectory}/<name>.md.`),
  planPath: optionalString().describe('Optional linked plan artifact path.'),
  status: optionalWriteProposalStatus,
  overview: optionalString(),
  patchPath: z.string().min(1).describe('Workspace-relative path to a patch file containing a multi-file unified diff.'),
  files: z.array(proposalPatchFileMetadataSchema).min(1).max(120),
  allowDroppingItems: z.boolean().optional().describe('Set true only when intentionally replacing an existing proposal with fewer file items.'),
}).strict();

const proposalItemUpdateInputSchema = z.object({
  id: z.string().min(1).max(100),
  status: proposalItemStatusSchema.optional(),
  viewed: z.boolean().optional(),
  comment: optionalString(),
}).strict().refine(value => value.status || typeof value.viewed === 'boolean' || typeof value.comment === 'string', {
  message: 'Provide at least one item update',
});

const updateProposalInputSchema = z.object({
  proposalPath: optionalString().describe(`Optional artifact path. Omit to use the thread's latest proposal. Must be ${proposalDirectory}/<name>.md.`),
  status: optionalUpdateProposalStatus,
  approveAllPending: z.boolean().optional(),
  approveAllViewed: z.boolean().optional(),
  rejectAllPending: z.boolean().optional(),
  requestChanges: optionalString(),
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

const hasContentBlock = (value: string | undefined) => typeof value === 'string';
const hasUnifiedDiff = (value: string | undefined) =>
  typeof value === 'string' && value.trim().length > 0;

const hasConcreteProposalContent = (file: z.infer<typeof proposalFileInputSchema>) => {
  if (file.kind === 'file_create') return hasContentBlock(file.proposedContent) || hasUnifiedDiff(file.diff);
  if (file.kind === 'file_delete') return true;
  return hasUnifiedDiff(file.diff);
};

const proposalContentError = (file: z.infer<typeof proposalFileInputSchema>) => {
  const required = file.kind === 'file_create'
    ? 'file_create needs proposedContent or a create-style unified diff'
    : file.kind === 'file_delete'
      ? 'file_delete needs an existing path'
      : 'file_edit needs a unified diff that applies to the current file';
  return `File proposal item ${file.path} is incomplete (${required}).`;
};

const assertProposalFileInputsComplete = (files: Array<z.infer<typeof proposalFileInputSchema>>) => {
  const incomplete = files.filter(file => !hasConcreteProposalContent(file));
  if (!incomplete.length) return;

  const examples = incomplete
    .slice(0, 8)
    .map(file => proposalContentError(file))
    .join(' ');
  const omitted = incomplete.length > 8 ? ` ${incomplete.length - 8} more incomplete item(s) omitted.` : '';
  throw new Error(`${incomplete.length} proposal file item(s) are incomplete. ${examples}${omitted}`);
};

const summarizeToolPayloadInput = ({ input }: { input?: unknown }) => summarizeProposalToolInput(input);

const proposalToolTransform = {
  display: {
    input: summarizeToolPayloadInput,
  },
  transcript: {
    input: summarizeToolPayloadInput,
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

const readPortalFile = async (path: string, context: any) => {
  const result = await routePortalTool('read', { path }, context);
  const record = isRecord(result) ? result : {};
  if (record.ok !== true) return { ok: false as const, error: portalError(result, `Unable to read ${path}`) };
  if (typeof record.content !== 'string') return { ok: false as const, error: `Portal read returned no content for ${path}` };
  return { ok: true as const, content: record.content };
};

const readPortalFileHash = async (path: string, context: any) => {
  const result = await routePortalTool('portal.editor.hash', { path }, context);
  const record = isRecord(result) ? result : {};
  if (record.ok === false) return { ok: false as const, error: portalError(result, `Unable to hash ${path}`) };
  if (typeof record.contentHash !== 'string') return { ok: false as const, error: `Portal hash returned no contentHash for ${path}` };
  return {
    ok: true as const,
    contentHash: record.contentHash,
    lineCount: typeof record.lineCount === 'number' ? record.lineCount : undefined,
  };
};

const previewPortalDiff = async (path: string, diff: string, context: any) => {
  const result = await routePortalTool('portal.editor.diffPreview', { path, diff }, context);
  const record = isRecord(result) ? result : {};
  if (record.ok === false) return { ok: false as const, error: portalError(result, `Unable to preview diff for ${path}`) };
  if (
    typeof record.currentHash !== 'string'
    || typeof record.proposedHash !== 'string'
    || typeof record.proposedContent !== 'string'
    || typeof record.additions !== 'number'
    || typeof record.deletions !== 'number'
  ) {
    return { ok: false as const, error: `Portal diff preview returned incomplete metadata for ${path}` };
  }
  return {
    ok: true as const,
    currentHash: record.currentHash,
    proposedHash: record.proposedHash,
    proposedContent: record.proposedContent,
    additions: record.additions,
    deletions: record.deletions,
  };
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

type ProposalFileInput = z.infer<typeof proposalFileInputSchema>;

type PreparedProposalFile = {
  input: ProposalFileInput;
  currentHash?: string;
  proposedHash?: string;
  additions: number;
  deletions: number;
  body: ProposalBody['items'][number];
};

const assertUsableDiff = (path: string, diff: string | undefined) => {
  const sections = splitUnifiedDiffByFile(diff);
  if (sections.ok) {
    if (sections.value.length > 1) {
      throw new Error(`File proposal item ${path} has a multi-file unified diff. Use one proposal item per source file.`);
    }
    const [section] = sections.value;
    if (section.path !== path) {
      throw new Error(`File proposal item ${path} has a unified diff for ${section.path}. The diff path must match the item path.`);
    }
  }

  const parsed = parseUnifiedDiff(diff);
  if (!parsed.ok) throw new Error(`File proposal item ${path} has an invalid unified diff: ${parsed.error}`);
  if (isLikelyProseUnifiedDiff(diff)) {
    throw new Error(`File proposal item ${path} has prose in its unified diff. Provide actual code diff hunks, not implementation notes.`);
  }
  return parsed.value;
};

const assertPathMissingForCreate = async (path: string, context: any) => {
  const existing = await readPortalFileHash(path, context);
  if (existing.ok) {
    throw new Error(`File proposal item ${path} is a file_create but the target path already exists. Use file_edit instead.`);
  }
  if (!isMissingPathError(existing.error)) throw new Error(existing.error);
};

const prepareProposalFileInput = async (file: ProposalFileInput, context: any): Promise<PreparedProposalFile> => {
  if (file.kind === 'file_edit') {
    if (!file.diff) throw new Error(proposalContentError(file));
    assertUsableDiff(file.path, file.diff);
    const preview = await previewPortalDiff(file.path, file.diff, context);
    if (!preview.ok) throw new Error(preview.error);
    return {
      input: file,
      currentHash: preview.currentHash,
      proposedHash: preview.proposedHash,
      additions: preview.additions,
      deletions: preview.deletions,
      body: {
        id: '',
        description: file.description,
        rationale: file.rationale,
        diff: file.diff,
      },
    };
  }

  if (file.kind === 'file_delete') {
    const current = await readPortalFileHash(file.path, context);
    if (!current.ok) throw new Error(current.error);
    return {
      input: file,
      currentHash: current.contentHash,
      additions: 0,
      deletions: current.lineCount ?? 0,
      body: {
        id: '',
        description: file.description,
        rationale: file.rationale,
      },
    };
  }

  await assertPathMissingForCreate(file.path, context);
  const proposedContent = file.proposedContent;
  if (file.diff) assertUsableDiff(file.path, file.diff);
  const diffProposed = file.diff && proposedContent === undefined
    ? (() => {
        const applied = applyUnifiedDiff('', file.diff!);
        if (!applied.ok) throw new Error(`File proposal item ${file.path} has an invalid create diff: ${applied.error}`);
        return applied.value.content;
      })()
    : undefined;
  const concreteProposedContent = proposedContent ?? diffProposed;
  if (concreteProposedContent === undefined) throw new Error(proposalContentError(file));
  const counts = file.diff ? countUnifiedDiffChanges(file.diff) : countProposalChanges({
    kind: file.kind,
    proposedContent: concreteProposedContent,
  });
  return {
    input: file,
    proposedHash: hashText(concreteProposedContent),
    additions: counts.additions,
    deletions: counts.deletions,
    body: {
      id: '',
      description: file.description,
      rationale: file.rationale,
      diff: file.diff,
      proposedContent,
    },
  };
};

const uniqueByPath = <T extends { path: string }>(items: T[], label: string) => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (seen.has(item.path)) duplicates.add(item.path);
    seen.add(item.path);
  }
  if (duplicates.size) {
    throw new Error(`${label} contains duplicate path(s): ${Array.from(duplicates).join(', ')}`);
  }
};

const formatPathList = (paths: string[]) => {
  const shown = paths.slice(0, 8).join(', ');
  return paths.length > 8 ? `${shown}, ... ${paths.length - 8} more` : shown;
};

const buildProposalFilesFromPatch = (
  metadataInput: Array<z.input<typeof proposalPatchFileMetadataSchema>>,
  patchContent: string,
): ProposalFileInput[] => {
  const metadata = z.array(proposalPatchFileMetadataSchema).parse(metadataInput);
  uniqueByPath(metadata, 'Proposal patch metadata');
  const split = splitUnifiedDiffByFile(patchContent);
  if (!split.ok) throw new Error(split.error);
  uniqueByPath(split.value, 'Proposal patch');

  const unsupported = split.value.filter(section => !section.oldPath || !section.newPath || section.oldPath !== section.newPath);
  if (unsupported.length) {
    throw new Error(
      `write_proposal_patch supports file_edit diffs only. Use write_proposal for creates/deletes/renames: ${formatPathList(unsupported.map(section => section.path))}`,
    );
  }

  const patchPaths = new Set(split.value.map(section => section.path));
  const metadataPaths = new Set(metadata.map(file => file.path));
  const missingInPatch = metadata.filter(file => !patchPaths.has(file.path)).map(file => file.path);
  const missingMetadata = split.value.filter(section => !metadataPaths.has(section.path)).map(section => section.path);
  const errors = [
    ...(missingInPatch.length ? [`metadata paths missing from patch: ${formatPathList(missingInPatch)}`] : []),
    ...(missingMetadata.length ? [`patch paths missing metadata: ${formatPathList(missingMetadata)}`] : []),
  ];
  if (errors.length) throw new Error(`Proposal patch paths must match metadata paths exactly (${errors.join('; ')}).`);

  const sectionsByPath = new Map(split.value.map(section => [section.path, section]));
  return metadata.map(file => {
    const section = sectionsByPath.get(file.path);
    if (!section) throw new Error(`Proposal patch is missing ${file.path}.`);
    return proposalFileInputSchema.parse({
      kind: 'file_edit',
      id: file.id,
      path: file.path,
      title: file.title,
      description: file.description,
      rationale: file.rationale,
      diff: section.diff,
    });
  });
};

const assertReplacementDoesNotDropItems = async (
  artifactPath: string,
  incomingPaths: string[],
  allowDroppingItems: boolean | undefined,
  context: any,
) => {
  if (allowDroppingItems) return;
  const read = await readPortalFile(artifactPath, context);
  if (!read.ok) {
    if (isMissingPathError(read.error)) return;
    throw new Error(read.error);
  }

  let parsed: ReturnType<typeof parseProposalArtifact>;
  try {
    parsed = parseProposalArtifact(read.content);
  } catch {
    return;
  }

  const incoming = new Set(incomingPaths);
  const existingPaths = parsed.frontmatter.items
    .filter(item => item.kind === 'file_edit' || item.kind === 'file_create' || item.kind === 'file_delete')
    .map(item => item.path)
    .filter((itemPath): itemPath is string => typeof itemPath === 'string');
  const missing = existingPaths.filter(path => !incoming.has(path));
  if (missing.length && incomingPaths.length < existingPaths.length) {
    throw new Error(
      `Replacement proposal has fewer file items than existing ${artifactPath}; missing ${formatPathList(missing)}. Set allowDroppingItems: true only if this is intentional.`,
    );
  }
};

export const writeProposalTool = createTool({
  id: 'write_proposal',
  strict: true,
  description: [
    'Create a git-scoped proposed change artifact at .agents/proposals/<name>.md.',
    'Use this before mutating source files for Guided work: new features, significant refactors, migrations, schema changes, cross-cutting changes, risky or production-sensitive work, multi-file implementation, or work that already has an ExecPlan artifact.',
    'If a human confirms a Guided plan but no proposal exists, create the proposal instead of editing source files.',
    'For file_edit, provide a real unified diff that applies to the current repository file. The tool reads the file and computes current_hash.',
    'For file_delete, provide only the path. The tool reads the file metadata and computes current_hash.',
    'For file_create, provide proposedContent or a create-style unified diff. The target path must not already exist.',
    'Optional prose belongs in description or rationale, never in diff or proposedContent.',
    'This tool only writes the proposal artifact. It does not apply proposed changes.',
  ].join('\n'),
  inputSchema: writeProposalInputSchema,
  outputSchema: proposalToolOutputSchema,
  transform: proposalToolTransform,
  execute: async (input, context) => {
    let path: string | undefined;
    try {
      await getGitProposalBinding(context);
      const { threadId } = await getThreadRecord(context);
      const proposalInput = writeProposalInputSchema.parse(input);
      assertProposalFileInputsComplete(proposalInput.files);
      const artifactPath = proposalInput.proposalPath ? validateProposalPath(proposalInput.proposalPath) : proposalPathForName(proposalInput.title);
      path = artifactPath;
      const now = new Date().toISOString();
      const preparedFiles = await Promise.all(proposalInput.files.map(file => prepareProposalFileInput(file, context)));
      const items: ProposalItem[] = preparedFiles.map((prepared, index) => {
        const file = prepared.input;
        return proposalItemSchema.parse({
          id: file.id ?? itemIdForPath(file.path, index),
          kind: file.kind,
          status: 'pending',
          title: file.title ?? file.path,
          path: file.path,
          additions: prepared.additions,
          deletions: prepared.deletions,
          viewed: false,
          current_hash: prepared.currentHash,
          proposed_hash: prepared.proposedHash,
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
        items: preparedFiles.map((prepared, index) => ({
          ...prepared.body,
          id: items[index].id,
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

export const writeProposalPatchTool = createTool({
  id: 'write_proposal_patch',
  strict: true,
  description: [
    'Create a git-scoped proposal artifact from a workspace patch file at .agents/proposals/<name>.md.',
    'Use this for larger proposal regeneration instead of assembling large files[].diff JSON payloads.',
    'Write a multi-file unified patch to a workspace scratch path, then pass patchPath and one metadata entry per file.',
    'The patch file paths and files[].path values must match exactly. Each metadata entry represents exactly one source file.',
    'This tool reads the patch through Portal, validates each file_edit diff against the live repository file, computes hashes, and writes the normal proposal artifact.',
    'This tool supports file_edit diffs only. Use write_proposal for file_create or file_delete proposal items.',
    'Do not print or read back large patch bodies before calling this tool.',
    'This tool only writes the proposal artifact. It does not apply proposed changes.',
  ].join('\n'),
  inputSchema: writeProposalPatchInputSchema,
  outputSchema: proposalToolOutputSchema,
  transform: proposalToolTransform,
  execute: async (input, context) => {
    let path: string | undefined;
    try {
      await getGitProposalBinding(context);
      const { threadId } = await getThreadRecord(context);
      const proposalInput = writeProposalPatchInputSchema.parse(input);
      const artifactPath = proposalInput.proposalPath ? validateProposalPath(proposalInput.proposalPath) : proposalPathForName(proposalInput.title);
      path = artifactPath;

      const patch = await readPortalFile(proposalInput.patchPath, context);
      if (!patch.ok) return toolError(patch.error, artifactPath);

      const files = buildProposalFilesFromPatch(proposalInput.files, patch.content);
      assertProposalFileInputsComplete(files);
      await assertReplacementDoesNotDropItems(
        artifactPath,
        files.map(file => file.path),
        proposalInput.allowDroppingItems,
        context,
      );

      const now = new Date().toISOString();
      const preparedFiles = await Promise.all(files.map(file => prepareProposalFileInput(file, context)));
      const items: ProposalItem[] = preparedFiles.map((prepared, index) => {
        const file = prepared.input;
        return proposalItemSchema.parse({
          id: file.id ?? itemIdForPath(file.path, index),
          kind: file.kind,
          status: 'pending',
          title: file.title ?? file.path,
          path: file.path,
          additions: prepared.additions,
          deletions: prepared.deletions,
          viewed: false,
          current_hash: prepared.currentHash,
          proposed_hash: prepared.proposedHash,
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
        items: preparedFiles.map((prepared, index) => ({
          ...prepared.body,
          id: items[index].id,
        })),
      };
      assertProposalItemsCompleteForStatuses(items, body.items, ['pending', 'approved', 'applied']);
      const content = renderProposalArtifact(frontmatter, body);
      const write = await writePortalFile(artifactPath, content, context);
      if (!write.ok) return toolError(write.error, artifactPath);

      const snapshot = proposalSnapshotFromFrontmatter(frontmatter, content);
      const output = buildSnapshotOutput(snapshot, write.bytes, {
        counts: { patchBytes: patch.content.length, files: files.length },
      });
      await updateThreadProposalMetadata(context, snapshot);
      return output;
    } catch (error) {
      return toolError(error, path);
    }
  },
  toModelOutput: output => proposalModelOutput('write_proposal_patch', output),
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
  strict: true,
  description: 'Update approval, viewed, rejection, or request-changes state in a proposal artifact.',
  inputSchema: updateProposalInputSchema,
  outputSchema: proposalToolOutputSchema,
  transform: proposalToolTransform,
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
  assertProposalFileInputsComplete,
  buildProposalFilesFromPatch,
  isSingleProposalFilePath,
  writeProposalInputSchema,
  writeProposalPatchInputSchema,
  updateProposalInputSchema,
};
