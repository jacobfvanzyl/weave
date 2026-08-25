import { describe, expect, test } from 'bun:test';
import {
  parsePortalRpcParams,
  parsePortalRpcResult,
  parseWorkspaceFileErrorData,
  parseWorkspaceFileWatchNotification,
  PORTAL_ACP_PATH,
  WORKSPACE_FILE_WATCH_EVENT_METHOD,
} from './index';

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

  test('parses bounded Workspace file requests and results', () => {
    expect(
      parsePortalRpcParams('workspace.file.write', {
        workspaceId: 'weave',
        path: 'src/main.ts',
        content: 'export {};\n',
        expectedContentHash: '0'.repeat(64),
      }),
    ).toEqual({
      workspaceId: 'weave',
      path: 'src/main.ts',
      content: 'export {};\n',
      expectedContentHash: '0'.repeat(64),
    });

    expect(
      parsePortalRpcResult('workspace.file.search', {
        path: '',
        matches: [{ path: 'src/main.ts', kind: 'content', line: 1, preview: 'export {};' }],
        truncated: false,
      }),
    ).toEqual({
      path: '',
      matches: [{ path: 'src/main.ts', kind: 'content', line: 1, preview: 'export {};' }],
      truncated: false,
    });

    expect(() =>
      parsePortalRpcParams('workspace.file.search', {
        workspaceId: 'weave',
        path: '',
        query: 'x'.repeat(257),
        scope: 'both',
      })
    ).toThrow('256');
  });

  test('requires conditional writes and validates watch notifications and typed errors', () => {
    expect(() =>
      parsePortalRpcParams('workspace.file.write', {
        workspaceId: 'weave',
        path: 'src/main.ts',
        content: 'unsafe',
      })
    ).toThrow('expectedContentHash');

    expect(
      parseWorkspaceFileWatchNotification(WORKSPACE_FILE_WATCH_EVENT_METHOD, {
        subscriptionId: 'watch-1',
        event: {
          kind: 'modify',
          paths: ['src/main.ts'],
          affectedDirectories: ['src'],
        },
      }),
    ).toEqual({
      subscriptionId: 'watch-1',
      event: {
        kind: 'modify',
        paths: ['src/main.ts'],
        affectedDirectories: ['src'],
      },
    });

    expect(
      parseWorkspaceFileErrorData({
        domain: 'workspace-filesystem',
        code: 'STALE_CONTENT',
        path: 'src/main.ts',
        expectedContentHash: '0'.repeat(64),
        actualContentHash: '1'.repeat(64),
      }),
    ).toEqual({
      domain: 'workspace-filesystem',
      code: 'STALE_CONTENT',
      path: 'src/main.ts',
      expectedContentHash: '0'.repeat(64),
      actualContentHash: '1'.repeat(64),
    });
  });
});
