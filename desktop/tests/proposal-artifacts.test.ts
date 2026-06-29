import { describe, expect, it } from 'vitest';
import {
  __proposalArtifactTest,
  proposalArtifactVersion,
  type ProposalFrontmatter,
} from '../../server/src/agent/mastra/tools/proposal-artifacts';
import { __proposalToolTest } from '../../server/src/agent/mastra/tools/proposal-tool';
import {
  getProposalCompleteness as getClientProposalCompleteness,
  parseProposalArtifact as parseClientProposalArtifact,
  renderProposalArtifact as renderClientProposalArtifact,
} from '../../packages/client/src/lib/proposal-artifacts';

const frontmatter = (overrides: Partial<ProposalFrontmatter> = {}): ProposalFrontmatter => ({
  weave_proposal_version: proposalArtifactVersion,
  id: 'guided-review',
  title: 'Guided Review Proposal',
  status: 'ready',
  scope: 'git',
  plan_path: '.agents/plans/guided-review.md',
  thread_ids: ['thread_abc123'],
  path: '.agents/proposals/guided-review.md',
  updated_at: '2026-06-28T12:00:00.000Z',
  summary: 'Preview and approve a focused file edit.',
  items: [
    {
      id: 'src-app-tsx-1',
      kind: 'file_edit',
      status: 'pending',
      title: 'Update app copy',
      path: 'src/App.tsx',
      additions: 1,
      deletions: 1,
      viewed: false,
      current_hash: 'old-hash',
      proposed_hash: 'new-hash',
    },
  ],
  ...overrides,
});

describe('proposal artifact helpers', () => {
  it('renders and parses proposal frontmatter and fenced file bodies', () => {
    const content = __proposalArtifactTest.renderProposalArtifact(frontmatter(), {
      overview: 'The proposal keeps approval state in frontmatter.',
      items: [
        {
          id: 'src-app-tsx-1',
          description: 'Replace the visible label.',
          rationale: 'Make the visible label clearer.',
          diff: '@@ -1 +1 @@\n-old\n+new',
          currentContent: 'old',
          proposedContent: 'new',
          reviewNotes: 'Needs a quick review.',
        },
      ],
    });

    const parsed = __proposalArtifactTest.parseProposalArtifact(content);
    expect(parsed.frontmatter).toMatchObject({
      weave_proposal_version: 1,
      id: 'guided-review',
      status: 'ready',
      path: '.agents/proposals/guided-review.md',
    });
    expect(parsed.body.overview).toContain('approval state');
    expect(parsed.body.items[0]).toMatchObject({
      id: 'src-app-tsx-1',
      description: 'Replace the visible label.',
      currentContent: 'old',
      proposedContent: 'new',
    });
  });

  it('rejects invalid proposal paths, statuses, and item kinds', () => {
    expect(__proposalArtifactTest.validateProposalPath('.agents/proposals/guided-review.md')).toBe('.agents/proposals/guided-review.md');
    expect(() => __proposalArtifactTest.validateProposalPath('.agents/plans/guided-review.md')).toThrow(/proposalPath/);
    expect(() => __proposalArtifactTest.parseProposalArtifact(__proposalArtifactTest.renderProposalArtifact(
      frontmatter({ status: 'bad' as ProposalFrontmatter['status'] }),
      { items: [] },
    ))).toThrow();
    expect(() => __proposalArtifactTest.parseProposalArtifact(__proposalArtifactTest.renderProposalArtifact(
      frontmatter({
        items: [
          {
            ...frontmatter().items[0],
            kind: 'bad_kind' as ProposalFrontmatter['items'][number]['kind'],
          },
        ],
      }),
      { items: [] },
    ))).toThrow();
  });

  it('round-trips viewed and approval state and records stale outcomes', () => {
    const reviewed = frontmatter({
      status: 'stale',
      items: [
        {
          ...frontmatter().items[0],
          status: 'stale',
          viewed: true,
          comment: 'Source changed before apply.',
        },
      ],
    });
    const content = __proposalArtifactTest.renderProposalArtifact(reviewed, {
      items: [
        {
          id: 'src-app-tsx-1',
          reviewNotes: 'Keep the reviewer note.',
          currentContent: 'old',
          proposedContent: 'new',
        },
      ],
    });

    const parsed = __proposalArtifactTest.parseProposalArtifact(content);
    expect(parsed.frontmatter.status).toBe('stale');
    expect(parsed.frontmatter.items[0]).toMatchObject({
      status: 'stale',
      viewed: true,
      comment: 'Source changed before apply.',
    });
    expect(parsed.body.items[0].reviewNotes).toContain('reviewer note');
  });

  it('infers proposal statuses from item approval state', () => {
    const item = frontmatter().items[0];
    expect(__proposalArtifactTest.inferProposalStatus([{ ...item, status: 'pending' }])).toBe('ready');
    expect(__proposalArtifactTest.inferProposalStatus([{ ...item, status: 'approved' }])).toBe('approved');
    expect(__proposalArtifactTest.inferProposalStatus([{ ...item, status: 'changes_requested' }])).toBe('changes_requested');
    expect(__proposalArtifactTest.inferProposalStatus([{ ...item, status: 'applied' }])).toBe('applied');
    expect(__proposalArtifactTest.inferProposalStatus([{ ...item, status: 'stale' }])).toBe('stale');
  });

  it('counts proposal changes from concrete content when available', () => {
    expect(__proposalArtifactTest.countProposalChanges({
      kind: 'file_edit',
      currentContent: ['a', 'b', 'c'].join('\n'),
      proposedContent: ['a', 'bb', 'c', 'd'].join('\n'),
    })).toEqual({ additions: 2, deletions: 1 });

    expect(__proposalArtifactTest.countProposalChanges({
      kind: 'file_create',
      proposedContent: ['one', 'two'].join('\n'),
    })).toEqual({ additions: 2, deletions: 0 });
  });

  it('marks code items with missing body sections as incomplete', () => {
    const item = {
      ...frontmatter().items[0],
      current_hash: undefined,
      proposed_hash: undefined,
    };
    const result = __proposalArtifactTest.getProposalItemCompleteness(item, undefined);

    expect(result.requiresCompleteness).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'missing_body_item',
      'missing_current_content',
      'missing_proposed_content',
    ]));
  });

  it('blocks approval when required current or proposed content is missing', () => {
    const baseItem = {
      ...frontmatter().items[0],
      status: 'approved' as const,
      current_hash: undefined,
      proposed_hash: undefined,
    };
    const editWithoutProposed = __proposalArtifactTest.getProposalCompleteness([baseItem], [
      { id: baseItem.id, currentContent: 'old' },
    ]);
    expect(editWithoutProposed.blockingIssues.map(issue => issue.code)).toContain('missing_proposed_content');
    expect(() => __proposalArtifactTest.assertProposalItemsCompleteForStatuses(
      [baseItem],
      [{ id: baseItem.id, currentContent: 'old' }],
      ['approved'],
    )).toThrow(/missing Proposed Content/);

    const createItem = {
      ...baseItem,
      id: 'new-file',
      kind: 'file_create' as const,
      current_hash: undefined,
    };
    expect(__proposalArtifactTest.getProposalCompleteness([createItem], [
      { id: createItem.id, currentContent: 'not enough' },
    ]).blockingIssues.map(issue => issue.code)).toContain('missing_proposed_content');

    const deleteItem = {
      ...baseItem,
      id: 'deleted-file',
      kind: 'file_delete' as const,
      proposed_hash: undefined,
    };
    expect(__proposalArtifactTest.getProposalCompleteness([deleteItem], [
      { id: deleteItem.id, proposedContent: 'not enough' },
    ]).blockingIssues.map(issue => issue.code)).toContain('missing_current_content');
  });

  it('blocks approval when concrete content hashes do not match frontmatter hashes', () => {
    const item = {
      ...frontmatter().items[0],
      status: 'approved' as const,
      current_hash: '000000000000',
      proposed_hash: '111111111111',
    };
    const result = __proposalArtifactTest.getProposalCompleteness([item], [
      { id: item.id, currentContent: 'old', proposedContent: 'new' },
    ]);

    expect(result.blockingIssues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'current_hash_mismatch',
      'proposed_hash_mismatch',
    ]));
    expect(() => __proposalArtifactTest.assertProposalItemsCompleteForStatuses(
      [item],
      [{ id: item.id, currentContent: 'old', proposedContent: 'new' }],
      ['approved'],
    )).toThrow(/does not match/);
  });

  it('allows incomplete rejected, stale, and changes-requested items to parse without becoming actionable blockers', () => {
    for (const status of ['changes_requested', 'stale', 'rejected'] as const) {
      const item = {
        ...frontmatter().items[0],
        status,
        current_hash: undefined,
        proposed_hash: undefined,
      };
      const result = __proposalArtifactTest.getProposalCompleteness([item], []);

      expect(result.complete).toBe(false);
      expect(result.items[0].requiresCompleteness).toBe(false);
      expect(result.blockingIssues).toHaveLength(0);
      __proposalArtifactTest.assertProposalItemsCompleteForStatuses([item], [], ['approved', 'applied']);
    }
  });

  it('blocks client approval persistence for incomplete code items', () => {
    const item = {
      ...frontmatter().items[0],
      current_hash: undefined,
      proposed_hash: undefined,
    };
    const content = __proposalArtifactTest.renderProposalArtifact(frontmatter({ items: [item] }), {
      items: [{ id: item.id, currentContent: 'old' }],
    });
    const parsed = parseClientProposalArtifact(content);
    const result = getClientProposalCompleteness(parsed.items, parsed.bodyItems);

    expect(result.blockingIssues.map(issue => issue.code)).toContain('missing_proposed_content');
    expect(() => renderClientProposalArtifact(parsed, [
      { ...parsed.items[0], status: 'approved' },
    ])).toThrow(/missing Proposed Content/);
  });

  it('rejects write_proposal file inputs without concrete content blocks', () => {
    expect(() => __proposalToolTest.writeProposalInputSchema.parse({
      title: 'Incomplete proposal',
      summary: 'Only a diff is not enough.',
      files: [
        {
          kind: 'file_edit',
          path: 'src/App.tsx',
          diff: '@@ -1 +1 @@\n-old\n+new',
        },
      ],
    })).toThrow(/currentContent and proposedContent/);

    expect(__proposalToolTest.writeProposalInputSchema.parse({
      title: 'Complete proposal',
      summary: 'Concrete current and proposed content is present.',
      files: [
        {
          kind: 'file_edit',
          path: 'src/App.tsx',
          currentContent: 'old',
          proposedContent: 'new',
        },
      ],
    }).files[0]).toMatchObject({
      currentContent: 'old',
      proposedContent: 'new',
    });
  });

  it('allows client approval persistence for complete code items', () => {
    const item = {
      ...frontmatter().items[0],
      current_hash: 'cba06b5736fa',
      proposed_hash: '11507a0e2f5e',
    };
    const content = __proposalArtifactTest.renderProposalArtifact(frontmatter({ items: [item] }), {
      items: [{ id: item.id, currentContent: 'old', proposedContent: 'new' }],
    });
    const parsed = parseClientProposalArtifact(content);

    const nextContent = renderClientProposalArtifact(parsed, [
      { ...parsed.items[0], status: 'approved' },
    ]);
    expect(nextContent).toContain('status: approved');
  });
});
