import { describe, expect, test } from 'bun:test';
import { parsePortalRpcResult, PORTAL_ACP_PATH } from './index';

describe('Portal protocol', () => {
  test('parses an attachment without leaking implementation details', () => {
    expect(
      parsePortalRpcResult('thread.attach', {
        thread: {
          threadId: 'thread-1',
          agentId: 'codex',
          workspaceId: 'weave',
          acpSessionId: 'session-1',
          status: 'active',
          createdAt: '2026-08-24T00:00:00.000Z',
          updatedAt: '2026-08-24T00:00:00.000Z',
        },
        connection: { path: PORTAL_ACP_PATH, threadId: 'thread-1', cwd: '/workspace' },
      }).connection,
    ).toEqual({ path: '/acp', threadId: 'thread-1', cwd: '/workspace' });
  });

  test('rejects malformed Thread state', () => {
    expect(() => parsePortalRpcResult('thread.list', { threads: [{ status: 'maybe' }] })).toThrow();
  });
});
