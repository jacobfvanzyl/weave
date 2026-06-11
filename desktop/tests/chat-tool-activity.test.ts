import { describe, expect, it } from 'vitest';
import { getAssistantContentRanges } from '../../packages/client/src/components/chat/assistant-content-ranges';
import {
  getToolActivitySideEffect,
  shouldRenderToolActivityChildren,
  summarizeToolActivity,
  toToolActivityCall,
} from '../../packages/client/src/components/chat/tool-activity';

describe('chat tool activity helpers', () => {
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

  it('detects hidden rename and plan side effects without rendering tool cards', () => {
    expect(getToolActivitySideEffect({
      toolCallId: 'rename-1',
      toolName: 'renameThreadTool',
      args: { title: 'A sharper thread title' },
      rawStatus: 'complete',
    })).toEqual({ type: 'renameThread', title: 'A sharper thread title' });

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
  });
});
