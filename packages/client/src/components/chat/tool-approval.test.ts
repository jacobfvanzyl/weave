import { describe, expect, it } from 'vitest';
import { getLatestPendingToolApproval, parseToolApprovalPart } from './tool-approval';

describe('tool approval parts', () => {
  it('recognizes native AI SDK approval parts', () => {
    expect(parseToolApprovalPart({
      type: 'tool-bash',
      toolCallId: 'call-1',
      state: 'approval-requested',
      input: { command: 'git reset --hard' },
      approval: { id: 'run-1::call-1' },
    })).toEqual({
      approvalId: 'run-1::call-1',
      toolCallId: 'call-1',
      toolName: 'bash',
      input: { command: 'git reset --hard' },
    });
  });

  it('ignores responded approvals when selecting the latest pending request', () => {
    expect(getLatestPendingToolApproval([{
      role: 'assistant',
      parts: [
        { type: 'tool-write_file', toolCallId: 'old', state: 'approval-responded', approval: { id: 'old', approved: true } },
        { type: 'dynamic-tool', toolName: 'exec_start', toolCallId: 'new', state: 'approval-requested', input: {}, approval: { id: 'new' } },
      ],
    }])).toEqual({
      approvalId: 'new',
      toolCallId: 'new',
      toolName: 'exec_start',
      input: {},
    });
  });
});
