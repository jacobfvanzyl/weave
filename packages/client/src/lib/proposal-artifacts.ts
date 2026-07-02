import { parseDocument, stringify } from 'yaml';
import type { ProposalItemStatus, ProposalStatus, ThreadProposal, ThreadProposalItem } from '../stores/chat-store';
import { parseUnifiedDiff } from './proposal-unified-diff';

export type ProposalBodyItem = {
  id: string;
  description?: string;
  rationale?: string;
  diff?: string;
  currentContent?: string;
  proposedContent?: string;
  reviewNotes?: string;
};

export type ParsedProposalArtifact = ThreadProposal & {
  raw: string;
  bodyItems: ProposalBodyItem[];
  overview?: string;
  frontmatter: Record<string, unknown>;
};

const proposalStatuses = new Set<ProposalStatus>([
  'draft',
  'ready',
  'partially_approved',
  'approved',
  'changes_requested',
  'applied',
  'rejected',
  'stale',
]);

const itemStatuses = new Set<ProposalItemStatus>([
  'pending',
  'approved',
  'changes_requested',
  'rejected',
  'applied',
  'stale',
]);

const codeProposalItemKinds = new Set(['file_edit', 'file_create', 'file_delete']);
const completenessRequiredStatuses = new Set<ProposalItemStatus>(['pending', 'approved', 'applied']);

export type ProposalCompletenessIssueCode =
  | 'missing_body_item'
  | 'missing_current_hash'
  | 'missing_current_content'
  | 'missing_proposed_content'
  | 'current_hash_mismatch'
  | 'proposed_hash_mismatch'
  | 'source_hash_mismatch'
  | 'source_file_exists'
  | 'source_read_failed'
  | 'diff_apply_failed';

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

const rightRotate = (value: number, amount: number) => (value >>> amount) | (value << (32 - amount));

const hashText = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bitLength, false);

  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Array<number>(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      w[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rightRotate(w[index - 15], 7) ^ rightRotate(w[index - 15], 18) ^ (w[index - 15] >>> 3);
      const s1 = rightRotate(w[index - 2], 17) ^ rightRotate(w[index - 2], 19) ^ (w[index - 2] >>> 10);
      w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hash] = h;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hash + s1 + ch + k[index] + w[index]) >>> 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hash = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hash) >>> 0;
  }

  return h.map(value => value.toString(16).padStart(8, '0')).join('').slice(0, 12);
};

const hasContentBlock = (value: string | undefined) => typeof value === 'string';
const hasUnifiedDiffBlock = (value: string | undefined) =>
  parseUnifiedDiff(value).ok;

const completenessIssue = (item: ThreadProposalItem, code: ProposalCompletenessIssueCode, message: string): ProposalCompletenessIssue => ({
  itemId: item.id,
  code,
  message: `Proposal item ${item.id} ${message}`,
});

export const getProposalItemCompleteness = (
  item: ThreadProposalItem,
  bodyItem: ProposalBodyItem | undefined,
): ProposalItemCompleteness => {
  const issues: ProposalCompletenessIssue[] = [];
  const isCodeItem = codeProposalItemKinds.has(item.kind);
  const requiresCompleteness = isCodeItem && completenessRequiredStatuses.has(item.status);

  if (!isCodeItem) return { itemId: item.id, complete: true, requiresCompleteness, issues };

  if (!bodyItem) {
    issues.push(completenessIssue(item, 'missing_body_item', 'is missing its Markdown body section.'));
  }

  const needsCurrent = item.kind === 'file_edit' || (item.kind === 'file_delete' && !item.currentHash);
  const needsProposed = item.kind === 'file_edit' || item.kind === 'file_create';
  const hasConcreteDiff = hasUnifiedDiffBlock(bodyItem?.diff);
  if (item.kind === 'file_edit' && hasConcreteDiff && !item.currentHash && !hasContentBlock(bodyItem?.currentContent)) {
    issues.push(completenessIssue(item, 'missing_current_hash', 'is missing current_hash for its Unified Diff.'));
  }
  if (!hasConcreteDiff && needsCurrent && !hasContentBlock(bodyItem?.currentContent)) {
    issues.push(completenessIssue(item, 'missing_current_content', 'is missing Current Content.'));
  }
  if (!hasConcreteDiff && needsProposed && !hasContentBlock(bodyItem?.proposedContent)) {
    issues.push(completenessIssue(item, 'missing_proposed_content', 'is missing Proposed Content.'));
  }
  if (item.currentHash && hasContentBlock(bodyItem?.currentContent) && hashText(bodyItem.currentContent) !== item.currentHash) {
    issues.push(completenessIssue(item, 'current_hash_mismatch', 'has Current Content that does not match current_hash.'));
  }
  if (item.proposedHash && hasContentBlock(bodyItem?.proposedContent) && hashText(bodyItem.proposedContent) !== item.proposedHash) {
    issues.push(completenessIssue(item, 'proposed_hash_mismatch', 'has Proposed Content that does not match proposed_hash.'));
  }

  return {
    itemId: item.id,
    complete: issues.length === 0,
    requiresCompleteness,
    issues,
  };
};

export const getProposalCompleteness = (items: ThreadProposalItem[], bodyItems: ProposalBodyItem[]) => {
  const bodyById = new Map(bodyItems.map(item => [item.id, item]));
  const proposalItems = items.map(item => getProposalItemCompleteness(item, bodyById.get(item.id)));
  const issues = proposalItems.flatMap(item => item.issues);
  return {
    complete: issues.length === 0,
    items: proposalItems,
    issues,
    blockingIssues: proposalItems.flatMap(item => item.requiresCompleteness ? item.issues : []),
  };
};

export const formatProposalCompletenessIssue = (issue: ProposalCompletenessIssue) => `${issue.message} Request revision before approval.`;

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

const itemHeadingPattern = /^### Item ([^:]+):\s*(.*)$/;

const parseFencedBlock = (value: string, label: string) => {
  const pattern = new RegExp(`### ${label}\\n\\n\`\`\`[^\\n]*\\n([\\s\\S]*?)\\n\`\`\``, 'm');
  return pattern.exec(value)?.[1]?.replace(/``\\`/g, '```');
};

const parseSectionText = (value: string, label: string) => {
  const pattern = new RegExp(`#### ${label}\\n+([\\s\\S]*?)(?=\\n#### |\\n### |$)`, 'm');
  return pattern.exec(value)?.[1]?.trim();
};

const parseBodyItems = (body: string): ProposalBodyItem[] => {
  const chunks: Array<{ id: string; content: string[] }> = [];
  let current: { id: string; content: string[] } | undefined;
  for (const line of body.split('\n')) {
    const heading = itemHeadingPattern.exec(line);
    if (heading) {
      if (current) chunks.push(current);
      current = { id: heading[1], content: [] };
      continue;
    }
    if (current) current.content.push(line);
  }
  if (current) chunks.push(current);
  return chunks.map(chunk => {
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
  });
};

const toItem = (value: unknown): ThreadProposalItem | undefined => {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  if (typeof record?.id !== 'string' || !itemStatuses.has(record.status as ProposalItemStatus)) return undefined;
  return {
    id: record.id,
    kind: typeof record.kind === 'string' ? record.kind : 'file_edit',
    status: record.status as ProposalItemStatus,
    title: typeof record.title === 'string' ? record.title : typeof record.path === 'string' ? record.path : record.id,
    path: typeof record.path === 'string' ? record.path : undefined,
    additions: typeof record.additions === 'number' ? record.additions : 0,
    deletions: typeof record.deletions === 'number' ? record.deletions : 0,
    viewed: record.viewed === true,
    currentHash: typeof record.current_hash === 'string' ? record.current_hash : undefined,
    proposedHash: typeof record.proposed_hash === 'string' ? record.proposed_hash : undefined,
    comment: typeof record.comment === 'string' ? record.comment : undefined,
  };
};

export const parseProposalArtifact = (raw: string): ParsedProposalArtifact => {
  const { yaml, body } = splitFrontmatter(raw);
  const document = parseDocument(yaml);
  if (document.errors.length) throw new Error(document.errors[0].message);
  const frontmatter = document.toJS() as Record<string, unknown>;
  const items = Array.isArray(frontmatter.items)
    ? frontmatter.items.map(toItem).filter((item): item is ThreadProposalItem => Boolean(item))
    : [];
  if (items.length === 0) throw new Error('Proposal artifact contains no items');
  const counts = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    if (item.viewed) acc.viewed = (acc.viewed ?? 0) + 1;
    acc.additions = (acc.additions ?? 0) + item.additions;
    acc.deletions = (acc.deletions ?? 0) + item.deletions;
    return acc;
  }, {});
  const status = proposalStatuses.has(frontmatter.status as ProposalStatus)
    ? frontmatter.status as ProposalStatus
    : 'ready';
  return {
    raw,
    frontmatter,
    bodyItems: parseBodyItems(body),
    overview: /## Overview\n\n([\s\S]*?)(?=\n## |$)/m.exec(body)?.[1]?.trim(),
    items,
    counts,
    status,
    id: typeof frontmatter.id === 'string' ? frontmatter.id : undefined,
    title: typeof frontmatter.title === 'string' ? frontmatter.title : undefined,
    path: typeof frontmatter.path === 'string' ? frontmatter.path : undefined,
    planPath: typeof frontmatter.plan_path === 'string' ? frontmatter.plan_path : undefined,
    summary: typeof frontmatter.summary === 'string' ? frontmatter.summary : undefined,
    updatedAt: typeof frontmatter.updated_at === 'string' ? frontmatter.updated_at : new Date().toISOString(),
  };
};

export const inferProposalStatus = (items: ThreadProposalItem[]): ProposalStatus => {
  if (items.some(item => item.status === 'stale')) return 'stale';
  if (items.some(item => item.status === 'changes_requested')) return 'changes_requested';
  if (items.every(item => item.status === 'applied')) return 'applied';
  if (items.every(item => item.status === 'rejected')) return 'rejected';
  if (items.every(item => item.status === 'approved' || item.status === 'applied')) return 'approved';
  if (items.some(item => item.status === 'approved' || item.status === 'applied')) return 'partially_approved';
  return 'ready';
};

export const renderProposalArtifact = (proposal: ParsedProposalArtifact, items: ThreadProposalItem[]) => {
  const previousItems = Array.isArray(proposal.frontmatter.items) ? proposal.frontmatter.items as Record<string, unknown>[] : [];
  const bodyById = new Map(proposal.bodyItems.map(item => [item.id, item]));
  const invalidApprovedIssue = items
    .filter(item => item.status === 'approved' || item.status === 'applied')
    .flatMap(item => getProposalItemCompleteness(item, bodyById.get(item.id)).issues)[0];
  if (invalidApprovedIssue) throw new Error(formatProposalCompletenessIssue(invalidApprovedIssue));

  const nextFrontmatter = {
    ...proposal.frontmatter,
    status: inferProposalStatus(items),
    updated_at: new Date().toISOString(),
    items: items.map(item => ({
      ...previousItems.find(candidate => candidate.id === item.id),
      id: item.id,
      kind: item.kind,
      status: item.status,
      title: item.title,
      ...(item.path ? { path: item.path } : {}),
      additions: item.additions,
      deletions: item.deletions,
      viewed: item.viewed,
      ...(item.currentHash ? { current_hash: item.currentHash } : {}),
      ...(item.proposedHash ? { proposed_hash: item.proposedHash } : {}),
      ...(item.comment ? { comment: item.comment } : {}),
    })),
  };
  const yaml = stringify(nextFrontmatter, { lineWidth: 0 }).trim();
  const title = typeof proposal.frontmatter.title === 'string' ? proposal.frontmatter.title : proposal.title ?? 'Proposal';
  const body = [
    `# ${title}`,
    '',
    '## Overview',
    '',
    proposal.overview || proposal.summary || 'Proposed changes.',
    '',
    '## Proposed Changes',
    '',
    ...items.map(item => {
      const detail = bodyById.get(item.id);
      return [
        `### Item ${item.id}: ${item.title}`,
        '',
        `- Status: ${item.status}`,
        `- Kind: ${item.kind}`,
        ...(item.path ? [`- Path: ${item.path}`] : []),
        `- Viewed: ${item.viewed ? 'yes' : 'no'}`,
        ...(detail?.description ? ['', '#### Description', '', detail.description] : []),
        ...(detail?.rationale ? ['', '#### Rationale', '', detail.rationale] : []),
        ...(item.comment ? ['', '#### Review Comment', '', item.comment] : []),
        ...(detail?.reviewNotes ? ['', '#### Review Notes', '', detail.reviewNotes] : []),
        ...(detail?.diff ? ['', '### Unified Diff', '', '```diff', detail.diff, '```'] : []),
        ...(detail?.currentContent !== undefined ? ['', '### Current Content', '', '```', detail.currentContent, '```'] : []),
        ...(detail?.proposedContent !== undefined ? ['', '### Proposed Content', '', '```', detail.proposedContent, '```'] : []),
      ].join('\n');
    }),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return `---\n${yaml}\n---\n\n${body}\n`;
};
