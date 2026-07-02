import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import { hashText } from './model-output';

export const proposalArtifactVersion = 1;
export const proposalDirectory = '.agents/proposals';

export const proposalStatusSchema = z.enum([
  'draft',
  'ready',
  'partially_approved',
  'approved',
  'changes_requested',
  'applied',
  'rejected',
  'stale',
]);

export const proposalItemStatusSchema = z.enum([
  'pending',
  'approved',
  'changes_requested',
  'rejected',
  'applied',
  'stale',
]);

export const proposalItemKindSchema = z.enum([
  'file_edit',
  'file_create',
  'file_delete',
  'command',
  'migration',
  'dependency',
  'external_action',
]);

export const proposalItemSchema = z.object({
  id: z.string().min(1).max(100),
  kind: proposalItemKindSchema,
  status: proposalItemStatusSchema,
  title: z.string().min(1).max(240),
  path: z.string().min(1).optional(),
  additions: z.number().int().min(0).default(0),
  deletions: z.number().int().min(0).default(0),
  viewed: z.boolean().default(false),
  current_hash: z.string().optional(),
  proposed_hash: z.string().optional(),
  applied_at: z.string().optional(),
  comment: z.string().optional(),
}).strict();

export const proposalFrontmatterSchema = z.object({
  weave_proposal_version: z.literal(proposalArtifactVersion),
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(180),
  status: proposalStatusSchema,
  scope: z.literal('git'),
  plan_path: z.string().optional(),
  thread_ids: z.array(z.string().min(1)).default([]),
  path: z.string().min(1),
  updated_at: z.string().min(1),
  summary: z.string().min(1).max(500),
  items: z.array(proposalItemSchema).min(1).max(120),
}).strict();

export type ProposalStatus = z.infer<typeof proposalStatusSchema>;
export type ProposalItemStatus = z.infer<typeof proposalItemStatusSchema>;
export type ProposalItemKind = z.infer<typeof proposalItemKindSchema>;
export type ProposalItem = z.infer<typeof proposalItemSchema>;
export type ProposalFrontmatter = z.infer<typeof proposalFrontmatterSchema>;

export type ProposalBodyItem = {
  id: string;
  description?: string;
  rationale?: string;
  diff?: string;
  currentContent?: string;
  proposedContent?: string;
  reviewNotes?: string;
};

export type ProposalBody = {
  overview?: string;
  items: ProposalBodyItem[];
};

export type ParsedProposalArtifact = {
  frontmatter: ProposalFrontmatter;
  body: ProposalBody;
  rawBody: string;
};

export type ProposalCompletenessIssueCode =
  | 'missing_body_item'
  | 'missing_current_content'
  | 'missing_proposed_content'
  | 'current_hash_mismatch'
  | 'proposed_hash_mismatch';

export type ProposalCompletenessIssue = {
  itemId: string;
  code: ProposalCompletenessIssueCode;
  message: string;
};

export type ProposalItemCompleteness = {
  itemId: string;
  complete: boolean;
  requiresCompleteness: boolean;
  issues: ProposalCompletenessIssue[];
};

const codeProposalItemKinds = new Set<ProposalItemKind>(['file_edit', 'file_create', 'file_delete']);
const completenessRequiredStatuses = new Set<ProposalItemStatus>(['pending', 'approved', 'applied']);
const maxExactContentComparisonCells = 250_000;

const hasContentBlock = (value: string | undefined) => typeof value === 'string';
const hasUnifiedDiffBlock = (value: string | undefined) =>
  typeof value === 'string' && value.trim().length > 0 && /^@@ /m.test(value);

const issue = (item: ProposalItem, code: ProposalCompletenessIssueCode, message: string): ProposalCompletenessIssue => ({
  itemId: item.id,
  code,
  message: `Proposal item ${item.id} ${message}`,
});

export const getProposalItemCompleteness = (
  item: ProposalItem,
  bodyItem: ProposalBodyItem | undefined,
): ProposalItemCompleteness => {
  const issues: ProposalCompletenessIssue[] = [];
  const requiresCompleteness = codeProposalItemKinds.has(item.kind) && completenessRequiredStatuses.has(item.status);

  if (!codeProposalItemKinds.has(item.kind)) {
    return { itemId: item.id, complete: true, requiresCompleteness: false, issues };
  }

  if (!bodyItem) {
    issues.push(issue(item, 'missing_body_item', 'is missing its Markdown body section.'));
  }

  const needsCurrent = item.kind === 'file_edit' || item.kind === 'file_delete';
  const needsProposed = item.kind === 'file_edit' || item.kind === 'file_create';
  const hasConcreteDiff = hasUnifiedDiffBlock(bodyItem?.diff);
  if (!hasConcreteDiff && needsCurrent && !hasContentBlock(bodyItem?.currentContent)) {
    issues.push(issue(item, 'missing_current_content', 'is missing Current Content.'));
  }
  if (!hasConcreteDiff && needsProposed && !hasContentBlock(bodyItem?.proposedContent)) {
    issues.push(issue(item, 'missing_proposed_content', 'is missing Proposed Content.'));
  }
  if (item.current_hash && hasContentBlock(bodyItem?.currentContent) && hashText(bodyItem.currentContent) !== item.current_hash) {
    issues.push(issue(item, 'current_hash_mismatch', 'has Current Content that does not match current_hash.'));
  }
  if (item.proposed_hash && hasContentBlock(bodyItem?.proposedContent) && hashText(bodyItem.proposedContent) !== item.proposed_hash) {
    issues.push(issue(item, 'proposed_hash_mismatch', 'has Proposed Content that does not match proposed_hash.'));
  }

  return {
    itemId: item.id,
    complete: issues.length === 0,
    requiresCompleteness,
    issues,
  };
};

export const getProposalCompleteness = (
  items: ProposalItem[],
  bodyItems: ProposalBodyItem[],
) => {
  const bodyById = new Map(bodyItems.map(item => [item.id, item]));
  const itemsCompleteness = items.map(item => getProposalItemCompleteness(item, bodyById.get(item.id)));
  const issues = itemsCompleteness.flatMap(item => item.issues);
  return {
    complete: issues.length === 0,
    items: itemsCompleteness,
    issues,
    blockingIssues: itemsCompleteness.flatMap(item => item.requiresCompleteness ? item.issues : []),
  };
};

export const assertProposalItemsCompleteForStatuses = (
  items: ProposalItem[],
  bodyItems: ProposalBodyItem[],
  statuses: ProposalItemStatus[],
) => {
  const blockedStatuses = new Set(statuses);
  const bodyById = new Map(bodyItems.map(item => [item.id, item]));
  const issues = items
    .filter(item => codeProposalItemKinds.has(item.kind) && blockedStatuses.has(item.status))
    .flatMap(item => getProposalItemCompleteness(item, bodyById.get(item.id)).issues);
  if (issues.length > 0) throw new Error(issues[0].message);
};

const splitFrontmatter = (raw: string) => {
  if (!raw.startsWith('---\n')) throw new Error('Proposal artifact must start with YAML frontmatter');
  const end = raw.indexOf('\n---', 4);
  if (end === -1) throw new Error('Proposal artifact frontmatter is not closed');
  const contentStart = raw.indexOf('\n', end + 4);
  return {
    yaml: raw.slice(4, end),
    body: contentStart === -1 ? '' : raw.slice(contentStart + 1),
  };
};

export const slugifyProposalId = (value: string, fallback = 'proposal') => {
  const slug = value
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || fallback;
};

export const validateProposalPath = (value: string) => {
  const path = value.trim();
  if (!/^\.agents\/proposals\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.md$/.test(path)) {
    throw new Error('proposalPath must match .agents/proposals/<lowercase-docker-style-name>.md');
  }
  if (path.includes('..') || path.includes('\\') || path.includes('//')) {
    throw new Error('proposalPath cannot contain traversal or path separator escapes');
  }
  return path;
};

export const proposalPathForName = (name: string) => validateProposalPath(`${proposalDirectory}/${slugifyProposalId(name)}.md`);

const fence = (label: string, value: string | undefined, info = '') => value !== undefined
  ? [`### ${label}`, '', `\`\`\`${info}`, value.replace(/```/g, '``\\`'), '```', ''].join('\n')
  : '';

export const renderProposalArtifact = (frontmatter: ProposalFrontmatter, body: ProposalBody) => {
  const normalized = proposalFrontmatterSchema.parse(frontmatter);
  const yaml = stringify(normalized, { lineWidth: 0 }).trim();
  const itemById = new Map(body.items.map(item => [item.id, item]));
  const markdown = [
    `# ${normalized.title}`,
    '',
    '## Overview',
    '',
    body.overview?.trim() || normalized.summary,
    '',
    '## Proposed Changes',
    '',
    ...normalized.items.flatMap(item => {
      const detail = itemById.get(item.id);
      return [
        `### Item ${item.id}: ${item.title}`,
        '',
        `- Status: ${item.status}`,
        `- Kind: ${item.kind}`,
        ...(item.path ? [`- Path: ${item.path}`] : []),
        `- Viewed: ${item.viewed ? 'yes' : 'no'}`,
        ...(detail?.description ? ['', '#### Description', '', detail.description.trim()] : []),
        ...(detail?.rationale ? ['', '#### Rationale', '', detail.rationale.trim()] : []),
        ...(item.comment ? ['', '#### Review Comment', '', item.comment.trim()] : []),
        detail?.reviewNotes ? ['', '#### Review Notes', '', detail.reviewNotes.trim()] : '',
        fence('Unified Diff', detail?.diff, 'diff'),
        fence('Current Content', detail?.currentContent, ''),
        fence('Proposed Content', detail?.proposedContent, ''),
      ].flat().filter(line => line !== '').join('\n');
    }),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return `---\n${yaml}\n---\n\n${markdown}\n`;
};

const itemHeadingPattern = /^### Item ([^:]+):\s*(.*)$/;

const parseFencedBlock = (value: string, label: string) => {
  const pattern = new RegExp(`### ${label}\\n\\n\`\`\`[^\\n]*\\n([\\s\\S]*?)\\n\`\`\``, 'm');
  const match = pattern.exec(value);
  return match?.[1]?.replace(/``\\`/g, '```');
};

const parseSectionText = (value: string, label: string) => {
  const pattern = new RegExp(`#### ${label}\\n+([\\s\\S]*?)(?=\\n#### |\\n### |$)`, 'm');
  return pattern.exec(value)?.[1]?.trim();
};

export const parseProposalBody = (rawBody: string): ProposalBody => {
  const overview = /## Overview\n\n([\s\S]*?)(?=\n## |$)/m.exec(rawBody)?.[1]?.trim();
  const lines = rawBody.split('\n');
  const chunks: Array<{ id: string; title: string; content: string[] }> = [];
  let current: { id: string; title: string; content: string[] } | undefined;

  for (const line of lines) {
    const heading = itemHeadingPattern.exec(line);
    if (heading) {
      if (current) chunks.push(current);
      current = { id: heading[1], title: heading[2] ?? '', content: [] };
      continue;
    }
    if (current) current.content.push(line);
  }
  if (current) chunks.push(current);

  return {
    overview,
    items: chunks.map(chunk => {
      const content = chunk.content.join('\n').trim();
      return {
        id: chunk.id,
        description: parseSectionText(content, 'Description'),
        rationale: parseSectionText(content, 'Rationale'),
        reviewNotes: parseSectionText(content, 'Review Notes'),
        diff: parseFencedBlock(content, 'Unified Diff'),
        currentContent: parseFencedBlock(content, 'Current Content'),
        proposedContent: parseFencedBlock(content, 'Proposed Content'),
      };
    }),
  };
};

export const parseProposalArtifact = (raw: string): ParsedProposalArtifact => {
  const { yaml, body } = splitFrontmatter(raw);
  const document = parseDocument(yaml);
  if (document.errors.length) {
    throw new Error(`Proposal artifact frontmatter is invalid YAML: ${document.errors[0].message}`);
  }
  return {
    frontmatter: proposalFrontmatterSchema.parse(document.toJS()),
    body: parseProposalBody(body),
    rawBody: body,
  };
};

export const proposalSnapshotFromFrontmatter = (frontmatter: ProposalFrontmatter, content: string) => {
  const counts = frontmatter.items.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    if (item.viewed) acc.viewed += 1;
    acc.additions += item.additions;
    acc.deletions += item.deletions;
    return acc;
  }, {
    pending: 0,
    approved: 0,
    changes_requested: 0,
    rejected: 0,
    applied: 0,
    stale: 0,
    viewed: 0,
    additions: 0,
    deletions: 0,
  });

  return {
    version: frontmatter.weave_proposal_version,
    id: frontmatter.id,
    title: frontmatter.title,
    path: frontmatter.path,
    planPath: frontmatter.plan_path,
    status: frontmatter.status,
    summary: frontmatter.summary,
    items: frontmatter.items,
    counts,
    updatedAt: frontmatter.updated_at,
    contentHash: hashText(content),
  };
};

export type ProposalSnapshot = ReturnType<typeof proposalSnapshotFromFrontmatter>;

export const inferProposalStatus = (items: ProposalItem[]): ProposalStatus => {
  if (items.some(item => item.status === 'stale')) return 'stale';
  if (items.some(item => item.status === 'changes_requested')) return 'changes_requested';
  if (items.length > 0 && items.every(item => item.status === 'applied')) return 'applied';
  if (items.length > 0 && items.every(item => item.status === 'rejected')) return 'rejected';
  if (items.length > 0 && items.every(item => item.status === 'approved' || item.status === 'applied')) return 'approved';
  if (items.some(item => item.status === 'approved' || item.status === 'applied')) return 'partially_approved';
  return 'ready';
};

export const countDiffChanges = (diff: string | undefined) => {
  let additions = 0;
  let deletions = 0;
  for (const line of diff?.split('\n') ?? []) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
};

const splitComparableLines = (value: string | undefined) => {
  if (!value) return [];
  const normalized = value.endsWith('\n') ? value.slice(0, -1) : value;
  return normalized ? normalized.split('\n') : [];
};

const countExactContentChanges = (current: string[], proposed: string[]) => {
  let previous = new Array(proposed.length + 1).fill(0);
  let next = new Array(proposed.length + 1).fill(0);
  for (const currentLine of current) {
    for (let proposedIndex = 0; proposedIndex < proposed.length; proposedIndex += 1) {
      next[proposedIndex + 1] = currentLine === proposed[proposedIndex]
        ? previous[proposedIndex] + 1
        : Math.max(previous[proposedIndex + 1], next[proposedIndex]);
    }
    [previous, next] = [next, previous];
    next.fill(0);
  }

  const unchanged = previous[proposed.length] ?? 0;
  return {
    additions: proposed.length - unchanged,
    deletions: current.length - unchanged,
  };
};

const countBoundedContentChanges = (current: string[], proposed: string[]) => {
  let prefix = 0;
  while (prefix < current.length && prefix < proposed.length && current[prefix] === proposed[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < current.length - prefix
    && suffix < proposed.length - prefix
    && current[current.length - suffix - 1] === proposed[proposed.length - suffix - 1]
  ) {
    suffix += 1;
  }

  return {
    additions: proposed.length - prefix - suffix,
    deletions: current.length - prefix - suffix,
  };
};

const countContentChanges = (currentContent: string | undefined, proposedContent: string | undefined) => {
  const current = splitComparableLines(currentContent);
  const proposed = splitComparableLines(proposedContent);
  if (current.length === 0) return { additions: proposed.length, deletions: 0 };
  if (proposed.length === 0) return { additions: 0, deletions: current.length };

  if (current.length * proposed.length <= maxExactContentComparisonCells) {
    return countExactContentChanges(current, proposed);
  }

  return countBoundedContentChanges(current, proposed);
};

export const countProposalChanges = (input: {
  kind?: ProposalItemKind;
  diff?: string;
  currentContent?: string;
  proposedContent?: string;
}) => {
  if (input.diff) return countDiffChanges(input.diff);
  if (input.kind === 'file_create') {
    return { additions: splitComparableLines(input.proposedContent).length, deletions: 0 };
  }
  if (input.kind === 'file_delete') {
    return { additions: 0, deletions: splitComparableLines(input.currentContent).length };
  }
  if (input.currentContent !== undefined || input.proposedContent !== undefined) {
    return countContentChanges(input.currentContent, input.proposedContent);
  }
  return { additions: 0, deletions: 0 };
};

export const __proposalArtifactTest = {
  assertProposalItemsCompleteForStatuses,
  countDiffChanges,
  countProposalChanges,
  getProposalCompleteness,
  getProposalItemCompleteness,
  inferProposalStatus,
  parseProposalArtifact,
  parseProposalBody,
  proposalPathForName,
  renderProposalArtifact,
  validateProposalPath,
};
