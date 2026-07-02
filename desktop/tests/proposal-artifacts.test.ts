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
    expect(__proposalToolTest.buildProposalFilesFromPatch([
      { path: 'src/one.ts', description: 'Update one.' },
      { path: 'src/two.ts', rationale: 'Update two.' },
    ], patch)).toMatchObject([
      { kind: 'file_edit', path: 'src/one.ts', description: 'Update one.', diff: expect.stringContaining('ONE') },
      { kind: 'file_edit', path: 'src/two.ts', rationale: 'Update two.', diff: expect.stringContaining('TWO') },
    ]);
  });

  it('rejects patch metadata mismatches, unsupported patch item kinds, and combined item paths', () => {
    const editPatch = [
      'diff --git a/src/one.ts b/src/one.ts',
      '--- a/src/one.ts',
      '+++ b/src/one.ts',
      '@@ -1 +1 @@',
      '-one',
      '+ONE',
    ].join('\n');
    const createPatch = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1 @@',
      '+new',
    ].join('\n');

    expect(() => __proposalToolTest.writeProposalInputSchema.parse({
      title: 'Bad paths',
      summary: 'Combined paths are invalid.',
      files: [{ kind: 'file_edit', path: 'src/one.ts and src/two.ts', diff: '@@ -1 +1 @@\n-a\n+b' }],
    })).toThrow(/exactly one source file/);
    expect(() => __proposalToolTest.buildProposalFilesFromPatch([
      { path: 'src/two.ts' },
    ], editPatch)).toThrow(/paths must match metadata paths exactly/);
    expect(() => __proposalToolTest.buildProposalFilesFromPatch([
      { path: 'src/new.ts' },
    ], createPatch)).toThrow(/supports file_edit diffs only/);
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

  it('accepts null optional fields and diff-only write_proposal inputs', () => {
    const parsed = __proposalToolTest.writeProposalInputSchema.parse({
      title: 'Diff proposal',
      summary: 'A compact unified diff is enough.',
      proposalPath: null,
      planPath: null,
      overview: null,
      files: [
        {
          kind: 'file_edit',
          path: 'src/App.tsx',
          title: null,
          description: null,
          rationale: null,
          diff: '@@ -1 +1 @@\n-old\n+new',
          currentContent: null,
          proposedContent: null,
          currentHash: null,
        },
      ],
    });

    expect(parsed.title).toBe('Diff proposal');
    expect(parsed.summary).toBe('A compact unified diff is enough.');
    expect(parsed.proposalPath).toBeUndefined();
    expect(parsed.planPath).toBeUndefined();
    expect(parsed.overview).toBeUndefined();
    expect(parsed.files[0].path).toBe('src/App.tsx');
    expect(parsed.files[0].title).toBeUndefined();
    expect(parsed.files[0].diff).toBe('@@ -1 +1 @@\n-old\n+new');
    expect(parsed.files[0].currentContent).toBeUndefined();
    expect(parsed.files[0].proposedContent).toBeUndefined();
    expect(parsed.files[0].currentHash).toBeUndefined();

    __proposalToolTest.assertProposalFileInputsComplete(parsed.files);
    expect(() => __proposalToolTest.assertProposalFileInputsComplete(__proposalToolTest.writeProposalInputSchema.parse({
      title: 'Incomplete proposal',
      summary: 'No concrete code body is present.',
      files: [{ kind: 'file_edit', path: 'src/App.tsx' }],
    }).files)).toThrow(/file_edit needs a unified diff/);

    for (const file of [
      { kind: 'file_create' as const, path: 'src/new.ts', diff: '@@ -0,0 +1 @@\n+new' },
      { kind: 'file_delete' as const, path: 'src/old.ts' },
    ]) {
      __proposalToolTest.assertProposalFileInputsComplete(__proposalToolTest.writeProposalInputSchema.parse({
        title: 'Diff proposal',
        summary: 'Unified diff is concrete review content.',
        files: [file],
      }).files);
    }

    expect(() => __proposalToolTest.assertProposalFileInputsComplete(__proposalToolTest.writeProposalInputSchema.parse({
      title: 'Legacy body blocks',
      summary: 'New file_edit proposals must use repository-validated diffs.',
      files: [{ kind: 'file_edit', path: 'src/App.tsx', currentContent: 'old', proposedContent: 'new' }],
    }).files)).toThrow(/file_edit needs a unified diff/);
  });

  it('accepts null optional fields for write_proposal_patch inputs', () => {
    const parsed = __proposalToolTest.writeProposalPatchInputSchema.parse({
      title: 'Patch proposal',
      summary: 'Use a patch file for compact proposal generation.',
      proposalPath: null,
      planPath: null,
      overview: null,
      status: null,
      patchPath: '.agents/tmp/proposal.patch',
      allowDroppingItems: true,
      files: [
        {
          id: null,
          path: 'src/App.tsx',
          title: null,
          description: null,
          rationale: null,
        },
      ],
    });

    expect(parsed.proposalPath).toBeUndefined();
    expect(parsed.planPath).toBeUndefined();
    expect(parsed.overview).toBeUndefined();
    expect(parsed.status).toBeUndefined();
    expect(parsed.patchPath).toBe('.agents/tmp/proposal.patch');
    expect(parsed.files[0]).toMatchObject({ path: 'src/App.tsx' });
    expect(parsed.files[0].id).toBeUndefined();
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
