import { describe, expect, it } from 'vitest';
import {
  __proposalArtifactTest,
  proposalArtifactVersion,
  type ProposalFrontmatter,
} from '../../server/src/agent/mastra/tools/proposal-artifacts';
import { __proposalToolTest } from '../../server/src/agent/mastra/tools/proposal-tool';
import { hashText } from '../../server/src/agent/mastra/tools/model-output';
import {
  getProposalCompleteness as getClientProposalCompleteness,
  parseProposalArtifact as parseClientProposalArtifact,
  renderProposalArtifact as renderClientProposalArtifact,
} from '../../packages/client/src/lib/proposal-artifacts';
import { applyUnifiedDiff, isLikelyProseUnifiedDiff, parseUnifiedDiff, splitUnifiedDiffByFile } from '../../packages/client/src/lib/proposal-unified-diff';

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

const hashResult = (contentHash: string) => ({
  ok: true as const,
  contentHash,
  lineCount: undefined,
  size: undefined,
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

  it('prefers unified diff counts and bounds large content-only comparisons', () => {
    expect(__proposalArtifactTest.countProposalChanges({
      kind: 'file_edit',
      diff: '@@ -1,2 +1,3 @@\n a\n-old\n+new\n+extra',
      currentContent: 'ignored current content',
      proposedContent: 'ignored proposed content',
    })).toEqual({ additions: 2, deletions: 1 });

    const largeCurrent = Array.from({ length: 600 }, (_, index) => `line ${index}`).join('\n');
    const largeProposed = [
      ...Array.from({ length: 300 }, (_, index) => `line ${index}`),
      'changed middle',
      ...Array.from({ length: 299 }, (_, index) => `line ${index + 301}`),
    ].join('\n');
    expect(__proposalArtifactTest.countProposalChanges({
      kind: 'file_edit',
      currentContent: largeCurrent,
      proposedContent: largeProposed,
    })).toEqual({ additions: 1, deletions: 1 });
  });

  it('validates and applies concrete unified diffs', () => {
    const applied = applyUnifiedDiff([
      'import old;',
      'void main() {}',
      '',
    ].join('\n'), [
      '@@ -1,2 +1,2 @@',
      '-import old;',
      '+import new;',
      ' void main() {}',
    ].join('\n'));

    expect(applied).toEqual({
      ok: true,
      value: {
        content: ['import new;', 'void main() {}', ''].join('\n'),
        additions: 1,
        deletions: 1,
      },
    });
    expect(parseUnifiedDiff('Implementation details:\n- Move the column')).toMatchObject({
      ok: false,
    });
    expect(applyUnifiedDiff('old\n', '@@ -1 +1 @@\n-missing\n+new')).toMatchObject({
      ok: false,
    });
  });

  it('detects prose-like unified diff payloads', () => {
    expect(isLikelyProseUnifiedDiff([
      '@@ -1,1 +1,5 @@',
      '-Old columns in order: Date, Station, Barcode.',
      '+Implementation details:',
      '+- Keep the existing Date column builder.',
      '+- Move the Block column builder after Date.',
      '+- Remove the Barcode column.',
      '+- Remove the Total Count column.',
    ].join('\n'))).toBe(true);
    expect(isLikelyProseUnifiedDiff('@@ -1 +1 @@\n-final name = old;\n+final name = new;')).toBe(false);
  });

  it('splits multi-file patches into one file diff per proposal item', () => {
    const patch = [
      '--- a/src/one.ts',
      '+++ b/src/one.ts',
      '@@ -1 +1 @@',
      '-one',
      '+ONE',
      '--- a/src/two.ts',
      '+++ b/src/two.ts',
      '@@ -1 +1 @@',
      '-two',
      '+TWO',
    ].join('\n');

    expect(splitUnifiedDiffByFile(patch)).toMatchObject({
      ok: true,
      value: [
        { path: 'src/one.ts', oldPath: 'src/one.ts', newPath: 'src/one.ts' },
        { path: 'src/two.ts', oldPath: 'src/two.ts', newPath: 'src/two.ts' },
      ],
    });
  });

  it('validates proposal workspace paths and exact replacement edits', () => {
    expect(() => __proposalToolTest.proposalWriteInputSchema.parse({
      proposalPath: '.agents/proposals/demo.md',
      path: 'src/one.ts and src/two.ts',
      content: 'new',
    })).toThrow(/exactly one source file/);
    expect(__proposalToolTest.applyExactReplacements('one two three', [
      { oldText: 'two', newText: 'TWO' },
      { oldText: 'three', newText: 'THREE' },
    ])).toBe('one TWO THREE');
    expect(() => __proposalToolTest.applyExactReplacements('one two two', [
      { oldText: 'two', newText: 'TWO' },
    ])).toThrow(/matches more than once/);
    expect(() => __proposalToolTest.applyExactReplacements('abcdef', [
      { oldText: 'abc', newText: 'ABC' },
      { oldText: 'bcd', newText: 'BCD' },
    ])).toThrow(/overlaps/);
  });

  it('rebases draft mutations while preserving untouched review state', () => {
    const firstItem = {
      ...frontmatter().items[0],
      status: 'approved' as const,
      viewed: true,
      current_hash: hashText('old-a'),
      proposed_hash: hashText('reviewed-a'),
      comment: 'Looks good.',
    };
    const secondItem = {
      ...frontmatter().items[0],
      id: 'src-second-ts',
      title: 'Update second file',
      path: 'src/second.ts',
      status: 'approved' as const,
      viewed: true,
      current_hash: hashText('old-b'),
      proposed_hash: hashText('reviewed-b'),
      comment: 'Keep this approval.',
    };
    const latest = __proposalArtifactTest.parseProposalArtifact(__proposalArtifactTest.renderProposalArtifact(
      frontmatter({ status: 'draft', items: [firstItem, secondItem] }),
      {
        items: [
          { id: firstItem.id, currentContent: 'old-a', proposedContent: 'reviewed-a' },
          { id: secondItem.id, currentContent: 'old-b', proposedContent: 'reviewed-b' },
        ],
      },
    ));
    const changedFirstItem = {
      ...firstItem,
      status: 'pending' as const,
      viewed: false,
      proposed_hash: hashText('changed-a'),
      comment: undefined,
    };
    const staleSecondItem = {
      ...secondItem,
      status: 'pending' as const,
      viewed: false,
      comment: undefined,
    };
    const next = __proposalArtifactTest.parseProposalArtifact(__proposalArtifactTest.renderProposalArtifact(
      frontmatter({ status: 'draft', items: [changedFirstItem, staleSecondItem] }),
      {
        items: [
          { id: changedFirstItem.id, currentContent: 'old-a', proposedContent: 'changed-a' },
          { id: staleSecondItem.id, currentContent: 'old-b', proposedContent: 'stale-b' },
        ],
      },
    ));

    const merged = __proposalToolTest.mergeDraftArtifact(next, latest, { resetItemIds: new Set([firstItem.id]) });

    expect(merged.frontmatter.items[0]).toMatchObject({
      id: firstItem.id,
      status: 'pending',
      viewed: false,
      proposed_hash: hashText('changed-a'),
    });
    expect(merged.frontmatter.items[1]).toMatchObject({
      id: secondItem.id,
      status: 'approved',
      viewed: true,
      comment: 'Keep this approval.',
      proposed_hash: hashText('reviewed-b'),
    });
    expect(merged.body.items[1]).toMatchObject({
      id: secondItem.id,
      proposedContent: 'reviewed-b',
    });
  });

  it('includes review comments in compact proposal model output', () => {
    const output = __proposalToolTest.proposalModelOutput('proposal_status', {
      ok: true,
      path: '.agents/proposals/demo.md',
      status: 'draft',
      items: [{
        id: 'src-file-ts',
        kind: 'file_edit',
        status: 'changes_requested',
        title: 'Update file',
        path: 'src/file.ts',
        additions: 1,
        deletions: 0,
        viewed: true,
        comment: 'Please preserve the existing hover behavior.',
      }],
    });

    expect(output).toContain('src-file-ts [changes_requested] src/file.ts comment: Please preserve the existing hover behavior.');
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
      current_hash: 'cba06b5736fa',
      proposed_hash: undefined,
    };
    expect(__proposalArtifactTest.getProposalCompleteness([deleteItem], [
      { id: deleteItem.id },
    ]).blockingIssues).toHaveLength(0);

    expect(__proposalArtifactTest.getProposalCompleteness([{ ...deleteItem, current_hash: undefined }], [
      { id: deleteItem.id },
    ]).blockingIssues.map(issue => issue.code)).toContain('missing_current_content');
  });

  it('treats unified diffs as complete proposal review content', () => {
    const item = {
      ...frontmatter().items[0],
      status: 'approved' as const,
    };
    const diffOnlyBody = [{ id: item.id, diff: '@@ -1 +1 @@\n-old\n+new' }];
    const serverResult = __proposalArtifactTest.getProposalCompleteness([item], diffOnlyBody);

    expect(serverResult.blockingIssues).toHaveLength(0);
    __proposalArtifactTest.assertProposalItemsCompleteForStatuses(
      [item],
      diffOnlyBody,
      ['approved'],
    );

    const content = __proposalArtifactTest.renderProposalArtifact(frontmatter({ items: [item] }), {
      items: diffOnlyBody,
    });
    const parsed = parseClientProposalArtifact(content);
    const clientResult = getClientProposalCompleteness(parsed.items, parsed.bodyItems);

    expect(clientResult.blockingIssues).toHaveLength(0);
    const nextContent = renderClientProposalArtifact(parsed, [
      { ...parsed.items[0], status: 'approved' },
    ]);
    expect(nextContent).toContain('status: approved');
  });

  it('requires current_hash for diff-only file edits', () => {
    const item = {
      ...frontmatter().items[0],
      status: 'approved' as const,
      current_hash: undefined,
      proposed_hash: undefined,
    };
    const result = __proposalArtifactTest.getProposalCompleteness([item], [
      { id: item.id, diff: '@@ -1 +1 @@\n-old\n+new' },
    ]);

    expect(result.blockingIssues.map(issue => issue.code)).toContain('missing_current_hash');
    expect(() => __proposalArtifactTest.assertProposalItemsCompleteForStatuses(
      [item],
      [{ id: item.id, diff: '@@ -1 +1 @@\n-old\n+new' }],
      ['approved'],
    )).toThrow(/missing current_hash/);
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

  it('accepts proposal workspace tool schemas with null optional fields', () => {
    expect(__proposalToolTest.proposalStartInputSchema.parse({
      title: 'Draft proposal',
      summary: 'Use virtual file buffers.',
      proposalPath: null,
      planPath: null,
      overview: null,
    })).toMatchObject({
      title: 'Draft proposal',
      summary: 'Use virtual file buffers.',
    });
    expect(__proposalToolTest.proposalReadInputSchema.parse({
      proposalPath: null,
      path: 'src/App.tsx',
      offset: 2,
      limit: 4,
    })).toMatchObject({ path: 'src/App.tsx', offset: 2, limit: 4 });
    expect(__proposalToolTest.proposalWriteInputSchema.parse({
      proposalPath: null,
      path: 'src/App.tsx',
      content: 'new content',
      title: null,
      description: null,
      rationale: null,
    })).toMatchObject({ path: 'src/App.tsx', content: 'new content' });
    expect(__proposalToolTest.proposalEditInputSchema.parse({
      proposalPath: null,
      path: 'src/App.tsx',
      edits: [{ oldText: 'old', newText: 'new' }],
      title: null,
      description: null,
      rationale: null,
    })).toMatchObject({ path: 'src/App.tsx', edits: [{ oldText: 'old', newText: 'new' }] });
    expect(__proposalToolTest.proposalDeleteInputSchema.parse({
      proposalPath: null,
      path: 'src/App.tsx',
      title: null,
      description: null,
      rationale: null,
    })).toMatchObject({ path: 'src/App.tsx' });
    expect(__proposalToolTest.proposalDiscardInputSchema.parse({
      proposalPath: null,
      path: 'src/App.tsx',
    })).toMatchObject({ path: 'src/App.tsx' });
    expect(__proposalToolTest.proposalStatusInputSchema.parse({ proposalPath: null })).toEqual({});
    expect(__proposalToolTest.proposalFinalizeInputSchema.parse({ proposalPath: null })).toEqual({});
    expect(__proposalToolTest.proposalMarkInputSchema.parse({
      proposalPath: null,
      items: [{ id: 'item-1', status: 'applied', comment: null }],
    })).toMatchObject({ items: [{ id: 'item-1', status: 'applied' }] });
  });

  it('validates draft proposals before finalizing against live disk drift', async () => {
    const currentContent = 'old\n';
    const proposedContent = 'new\n';
    const editItem = {
      ...frontmatter().items[0],
      current_hash: hashText(currentContent),
      proposed_hash: hashText(proposedContent),
    };
    const editFrontmatter = frontmatter({ status: 'draft', items: [editItem] });
    const editBody = {
      items: [{ id: editItem.id, currentContent, proposedContent }],
    };

    await expect(__proposalToolTest.validateProposalForFinalize(editFrontmatter, editBody, {}, {
      readHash: async () => hashResult(hashText(currentContent)),
    })).resolves.toBeUndefined();

    await expect(__proposalToolTest.validateProposalForFinalize(editFrontmatter, editBody, {}, {
      readHash: async () => hashResult(hashText('changed\n')),
    })).rejects.toThrow(/source changed on disk/);

    const createItem = {
      ...editItem,
      id: 'src-new-ts',
      kind: 'file_create' as const,
      title: 'Create file',
      path: 'src/new.ts',
      current_hash: undefined,
      proposed_hash: hashText(proposedContent),
    };
    await expect(__proposalToolTest.validateProposalForFinalize(
      frontmatter({ status: 'draft', items: [createItem] }),
      { items: [{ id: createItem.id, proposedContent }] },
      {},
      { readHash: async () => hashResult(hashText('already exists')) },
    )).rejects.toThrow(/target now exists/);

    const deleteItem = {
      ...editItem,
      id: 'src-old-ts',
      kind: 'file_delete' as const,
      title: 'Delete file',
      path: 'src/old.ts',
      proposed_hash: undefined,
    };
    await expect(__proposalToolTest.validateProposalForFinalize(
      frontmatter({ status: 'draft', items: [deleteItem] }),
      { items: [{ id: deleteItem.id, currentContent }] },
      {},
      { readHash: async () => ({ ok: false as const, error: 'not found' }) },
    )).rejects.toThrow(/source file is missing/);

    await expect(__proposalToolTest.validateProposalForFinalize(
      editFrontmatter,
      { items: [{ id: editItem.id, currentContent, proposedContent: 'tampered\n' }] },
      {},
      { readHash: async () => hashResult(hashText(currentContent)) },
    )).rejects.toThrow(/Proposed Content|proposed_hash/);
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
