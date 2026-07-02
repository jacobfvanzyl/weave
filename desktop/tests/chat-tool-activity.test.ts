import { describe, expect, it } from 'vitest';
import {
  getAssistantContentRanges,
  getAutoCollapsedAssistantTextPartIndices,
  getDefaultAutoCollapsedAssistantTurnIds,
} from '../../packages/client/src/components/chat/assistant-content-ranges';
import {
  buildProposalImplementationMessage,
  buildProposalImplementationUserMessage,
  getProposalActionDisplay,
  getProposalActionDisplayLabel,
} from '../../packages/client/src/components/chat/proposal-implementation';
import {
  getToolActivityFollowTarget,
  getToolActivitySideEffect,
  getToolResultText,
  isProposalTool,
  isHiddenToolCall,
  shouldRenderToolActivityChildren,
  summarizeToolActivity,
  toToolActivityCall,
} from '../../packages/client/src/components/chat/tool-activity';

describe('chat tool activity helpers', () => {
  it('builds scoped proposal implementation instructions', () => {
    const message = buildProposalImplementationMessage({
      proposalPath: '.agents/proposals/demo.md',
      approvedItemIds: ['item-1', 'item-2'],
    });

    expect(message).toContain('Implement the approved proposal items from .agents/proposals/demo.md.');
    expect(message).toContain('Approved item ids: item-1, item-2');
    expect(message).toContain('Implement only approved items.');
    expect(message).toContain('Do not implement pending, rejected, stale, or changes-requested items.');
    expect(message).toContain('update the proposal artifact');
  });

  it('builds compact display metadata for proposal implementation messages', () => {
    const message = buildProposalImplementationUserMessage({
      id: 'request-1',
      proposalPath: '.agents/proposals/demo.md',
      approvedItemIds: ['item-1', 'item-2'],
      requestedAt: '2026-06-29T10:00:00.000Z',
    });

    expect(message.text).toContain('Implement the approved proposal items from .agents/proposals/demo.md.');
    expect(message.metadata).toMatchObject({
      proposalImplementation: {
        proposalPath: '.agents/proposals/demo.md',
        approvedItemIds: ['item-1', 'item-2'],
        mode: 'implement',
        requestedAt: '2026-06-29T10:00:00.000Z',
      },
      weaveDisplay: {
        kind: 'proposal_implementation_request',
        proposalPath: '.agents/proposals/demo.md',
      },
    });
    expect(getProposalActionDisplay(message.metadata)).toEqual({ kind: 'proposal_implementation_request' });
    expect(getProposalActionDisplayLabel({ kind: 'proposal_implementation_request' })).toBe('Implement proposal');
  });

  it('builds compact display metadata for proposal feedback messages', () => {
    const message = buildProposalImplementationUserMessage({
      id: 'request-2',
      proposalPath: '.agents/proposals/demo.md',
      approvedItemIds: [],
      mode: 'address_feedback',
      requestedAt: '2026-06-29T10:05:00.000Z',
    });

    expect(message.text).toContain('Address review feedback for the proposal at .agents/proposals/demo.md.');
    expect(message.metadata).toMatchObject({
      proposalImplementation: {
        proposalPath: '.agents/proposals/demo.md',
        approvedItemIds: [],
        mode: 'address_feedback',
        requestedAt: '2026-06-29T10:05:00.000Z',
      },
      weaveDisplay: {
        kind: 'proposal_review_feedback',
        proposalPath: '.agents/proposals/demo.md',
      },
    });
    expect(getProposalActionDisplay(message.metadata)).toEqual({ kind: 'proposal_review_feedback' });
    expect(getProposalActionDisplayLabel({ kind: 'proposal_review_feedback' })).toBe('Revise proposal');
  });

  it('classifies legacy proposal implementation metadata for compact rendering', () => {
    expect(getProposalActionDisplay({
      proposalImplementation: {
        proposalPath: '.agents/proposals/demo.md',
        mode: 'address_feedback',
      },
    })).toEqual({ kind: 'proposal_review_feedback' });

    expect(getProposalActionDisplay({
      proposalImplementation: {
        proposalPath: '.agents/proposals/demo.md',
        mode: 'implement',
      },
    })).toEqual({ kind: 'proposal_implementation_request' });
  });

  it('classifies nested assistant-ui custom metadata for compact rendering', () => {
    expect(getProposalActionDisplay({
      custom: {
        weaveDisplay: {
          kind: 'proposal_review_feedback',
        },
      },
    })).toEqual({ kind: 'proposal_review_feedback' });

    expect(getProposalActionDisplay({
      custom: {
        proposalImplementation: {
          proposalPath: '.agents/proposals/demo.md',
          mode: 'implement',
        },
      },
    })).toEqual({ kind: 'proposal_implementation_request' });
  });

  it('classifies persisted proposal action messages without metadata from text', () => {
    expect(getProposalActionDisplay(undefined, [
      'Address review feedback for the proposal at .agents/proposals/demo.md.',
      '',
      'Before editing anything, read the proposal artifact and its review comments.',
    ].join('\n'))).toEqual({ kind: 'proposal_review_feedback' });

    expect(getProposalActionDisplay(null, [
      'Implement the approved proposal items from .agents/proposals/demo.md.',
      '',
      'Approved item ids: item-1, item-2',
    ].join('\n'))).toEqual({ kind: 'proposal_implementation_request' });
  });

  it('does not split tool activity groups on hidden reasoning parts', () => {
    const parts = [
      { type: 'tool-call', toolCallId: 'read-1', toolName: 'read', args: { path: 'a.ts' }, result: 'ok' },
      { type: 'reasoning', text: 'I should inspect another file.' },
      { type: 'tool-call', toolCallId: 'read-2', toolName: 'read', args: { path: 'b.ts' }, result: 'ok' },
    ];

    expect(getAssistantContentRanges(parts, false)).toEqual([
      { type: 'tool-activity', indices: [0, 2] },
    ]);

    expect(getAssistantContentRanges(parts, true)).toEqual([
      { type: 'tool-activity', indices: [0] },
      { type: 'reasoning', indices: [1] },
      { type: 'tool-activity', indices: [2] },
    ]);
  });

  it('keeps steered user message data as a visible assistant content boundary', () => {
    const parts = [
      { type: 'text', text: 'First assistant segment.' },
      { type: 'data', name: 'user-message', data: { id: 'steer-1', contents: 'Use the same IoT checks.' } },
      { type: 'text', text: 'Second assistant segment.' },
    ];

    expect(getAssistantContentRanges(parts, false)).toEqual([
      { type: 'part', index: 0 },
      { type: 'part', index: 1 },
      { type: 'part', index: 2 },
    ]);
    expect(getAutoCollapsedAssistantTextPartIndices(parts, false)).toEqual([]);
  });

  it('selects only trailing final text when an assistant turn has earlier visible work', () => {
    const parts = [
      { type: 'reasoning', text: 'I should inspect the repo.' },
      { type: 'tool-call', toolCallId: 'read-1', toolName: 'read', args: { path: 'a.ts' }, result: 'ok' },
      { type: 'text', text: 'The fix is implemented.' },
    ];

    expect(getAutoCollapsedAssistantTextPartIndices(parts, true)).toEqual([2]);
    expect(getAutoCollapsedAssistantTextPartIndices(parts, false)).toEqual([2]);
  });

  it('selects trailing final text after persisted dynamic tool parts', () => {
    const parts = [
      {
        type: 'tool-read',
        toolCallId: 'read-1',
        input: { path: 'a.ts' },
        output: 'ok',
        state: 'output-available',
      },
      { type: 'text', text: 'The fix is implemented.' },
    ];

    expect(getAssistantContentRanges(parts, false)).toEqual([
      { type: 'tool-activity', indices: [0] },
      { type: 'part', index: 1 },
    ]);
    expect(getAutoCollapsedAssistantTextPartIndices(parts, false)).toEqual([1]);
  });

  it('derives default auto-collapsed turns from completed assistant messages', () => {
    const messages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        status: { type: 'complete' },
        parts: [
          { type: 'tool-bash', toolCallId: 'call-1', input: { command: 'npm test' }, output: 'ok', state: 'output-available' },
          { type: 'text', text: 'Done.' },
        ],
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        status: { type: 'complete' },
        parts: [{ type: 'text', text: 'Plain answer.' }],
      },
      {
        id: 'assistant-3',
        role: 'assistant',
        status: { type: 'running' },
        parts: [
          { type: 'tool-bash', toolCallId: 'call-2', input: { command: 'npm test' }, output: 'ok', state: 'output-available' },
          { type: 'text', text: 'Still running.' },
        ],
      },
    ];

    expect(getDefaultAutoCollapsedAssistantTurnIds(messages, false)).toEqual({ 'assistant-1': true });
    expect(getDefaultAutoCollapsedAssistantTurnIds(messages, false, { 'assistant-1': true })).toEqual({});
  });

  it('does not auto-collapse plain text-only turns or turns without a final text response', () => {
    expect(getAutoCollapsedAssistantTextPartIndices([
      { type: 'text', text: 'Just the answer.' },
    ], true)).toEqual([]);

    expect(getAutoCollapsedAssistantTextPartIndices([
      { type: 'text', text: 'I will inspect that.' },
      { type: 'tool-call', toolCallId: 'read-1', toolName: 'read', args: { path: 'a.ts' }, result: 'ok' },
    ], true)).toEqual([]);
  });

  it('summarizes collapsed tool activity without requiring child detail rendering', () => {
    const call = toToolActivityCall({
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'rg "needle" packages/client' },
      result: {
        toJSON() {
          throw new Error('result should not be serialized for a collapsed summary');
        },
      },
      status: { type: 'complete' },
    });

    expect(call).toMatchObject({ toolCallId: 'call-1', toolName: 'bash', rawStatus: 'complete' });
    expect(summarizeToolActivity([call!])).toBe('Explored 1 search');
    expect(shouldRenderToolActivityChildren(true, 1, true)).toBe(false);
  });

  it('keeps expanded and hidden tool rendering decisions explicit', () => {
    expect(shouldRenderToolActivityChildren(true, 1, false)).toBe(true);
    expect(shouldRenderToolActivityChildren(true, 0, false)).toBe(false);
    expect(shouldRenderToolActivityChildren(false, 1, false)).toBe(false);
  });

  it('summarizes edit results instead of rendering raw diffs', () => {
    expect(getToolResultText('edit', {
      ok: true,
      replacements: 2,
      diff: [
        '@@ -1,100 +1,100 @@',
        '-old value',
        '+new value',
      ].join('\n'),
    })).toBe('Applied 2 replacements.');
  });

  it('keeps rename hidden while rendering artifact plan tool cards', () => {
    expect(isHiddenToolCall({ toolCallId: 'rename-1', toolName: 'renameThreadTool' })).toBe(true);
    expect(isHiddenToolCall({ toolCallId: 'write-plan-1', toolName: 'write_plan' })).toBe(false);
    expect(isHiddenToolCall({ toolCallId: 'update-plan-1', toolName: 'update_plan' })).toBe(false);

    expect(getToolActivitySideEffect({
      toolCallId: 'rename-1',
      toolName: 'renameThreadTool',
      args: { title: 'A sharper thread title' },
      rawStatus: 'complete',
    })).toEqual({ type: 'renameThread', title: 'A sharper thread title' });
  });

  it('does not treat removed apply_proposal calls as proposal activity', () => {
    expect(isProposalTool('write_proposal')).toBe(true);
    expect(isProposalTool('update_proposal')).toBe(true);
    expect(isProposalTool('apply_proposal')).toBe(false);
    expect(isProposalTool('applyProposalTool')).toBe(false);
  });

  it('extracts legacy and artifact plan side effects', () => {
    const effect = getToolActivitySideEffect({
      toolCallId: 'plan-1',
      toolName: 'update_plan',
      args: {
        plan: [
          { step: 'Inspect hot path', status: 'completed' },
          { step: 'Patch render work', status: 'in_progress' },
        ],
      },
      rawStatus: 'incomplete',
    });

    expect(effect).toMatchObject({
      type: 'updatePlan',
      plan: {
        completed: 1,
        total: 2,
        isBusy: true,
      },
    });

    const artifactEffect = getToolActivitySideEffect({
      toolCallId: 'plan-2',
      toolName: 'write_plan',
      result: {
        ok: true,
        title: 'Plan Artifact Overhaul',
        path: '.agents/plans/bright-river.md',
        status: 'blocked',
        checklist: [
          { id: 'research', text: 'Research current plan tooling', status: 'completed' },
          { id: 'implement', text: 'Implement artifact-aware plan tools', status: 'blocked' },
        ],
        completed: 1,
        total: 2,
        updatedAt: '2026-06-18T12:00:00.000Z',
        contentHash: 'abc123',
      },
      rawStatus: 'complete',
    });

    expect(artifactEffect).toMatchObject({
      type: 'updatePlan',
      plan: {
        title: 'Plan Artifact Overhaul',
        path: '.agents/plans/bright-river.md',
        status: 'blocked',
        completed: 1,
        total: 2,
        updatedAt: '2026-06-18T12:00:00.000Z',
        contentHash: 'abc123',
        isBusy: false,
        plan: [
          { id: 'research', step: 'Research current plan tooling', status: 'completed' },
          { id: 'implement', step: 'Implement artifact-aware plan tools', status: 'blocked' },
        ],
      },
    });
  });

  it('extracts follow-write targets from successful write and edit tool calls', () => {
    expect(getToolActivityFollowTarget({
      toolCallId: 'write-1',
      toolName: 'write',
      args: { path: 'src/new.ts' },
      result: { ok: true, bytes: 42 },
    })).toEqual({ path: 'src/new.ts', line: 1, toolCallId: 'write-1' });

    expect(getToolActivityFollowTarget({
      toolCallId: 'edit-1',
      toolName: 'edit',
      args: { path: 'src/existing.ts' },
      result: {
        ok: true,
        diff: [
          '--- a/src/existing.ts',
          '+++ b/src/existing.ts',
          '@@ -10,6 +24,8 @@ export const value = 1;',
          '+export const next = 2;',
        ].join('\n'),
      },
    })).toEqual({ path: 'src/existing.ts', line: 24, toolCallId: 'edit-1' });
  });

  it('ignores failed or unrelated follow-write calls and falls back for malformed diffs', () => {
    expect(getToolActivityFollowTarget({
      toolCallId: 'read-1',
      toolName: 'read',
      args: { path: 'src/file.ts' },
      result: { ok: true },
    })).toBeNull();

    expect(getToolActivityFollowTarget({
      toolCallId: 'write-2',
      toolName: 'write',
      args: { path: 'src/file.ts' },
      result: { ok: false, error: 'nope' },
      isError: true,
    })).toBeNull();

    expect(getToolActivityFollowTarget({
      toolCallId: 'write-2b',
      toolName: 'write',
      args: { path: 'src/file.ts' },
      result: { ok: false, error: 'nope' },
    })).toBeNull();

    expect(getToolActivityFollowTarget({
      toolCallId: 'write-3',
      toolName: 'write',
      args: {},
      result: { ok: true },
    })).toBeNull();

    expect(getToolActivityFollowTarget({
      toolCallId: 'edit-2',
      toolName: 'edit',
      args: { path: 'src/file.ts' },
      result: { ok: true, diff: 'not a unified diff' },
    })).toEqual({ path: 'src/file.ts', line: 1, toolCallId: 'edit-2' });
  });
});
