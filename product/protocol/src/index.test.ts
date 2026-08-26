import { describe, expect, test } from 'bun:test';
import {
  parsePortalAuthChallenge,
  parsePortalAuthenticated,
  parsePortalPairRequest,
  parsePortalPairResult,
  parsePortalRpcParams,
  parsePortalRpcResult,
  parseWorkspaceFileErrorData,
  parseWorkspaceFileWatchNotification,
  PORTAL_ACP_PATH,
  WORKSPACE_FILE_WATCH_EVENT_METHOD,
} from './index';

describe('Portal protocol', () => {
  test('parses the key-authentication and pairing envelopes', () => {
    expect(parsePortalAuthChallenge({
      type: 'weave.portal.auth.challenge',
      challengeId: 'challenge-1',
      hostId: 'host-1',
      nonce: 'nonce',
      audience: '/rpc',
      origin: 'capacitor://localhost',
      expiresAt: '2026-08-26T00:00:00.000Z',
    })).toMatchObject({ hostId: 'host-1', audience: '/rpc' });
    expect(parsePortalAuthenticated({
      type: 'weave.portal.auth.authenticated',
      principal: { principalId: 'principal-1', credentialId: 'credential-1', label: 'Jaco’s iPad' },
    }).principal).toEqual({ principalId: 'principal-1', credentialId: 'credential-1', label: 'Jaco’s iPad' });
    expect(parsePortalPairRequest({
      type: 'weave.portal.pair.request',
      hostId: 'host-1',
      offerId: 'offer-1',
      secret: 'secret',
      label: 'Jaco’s iPad',
      publicKey: 'public-key',
    }).offerId).toBe('offer-1');
    expect(parsePortalPairResult({
      type: 'weave.portal.pair.result',
      hostId: 'host-1',
      displayName: 'Portal',
      principal: { principalId: 'principal-1', credentialId: 'credential-1', label: 'Jaco’s iPad' },
    }).hostId).toBe('host-1');
    expect(() => parsePortalAuthChallenge({
      type: 'weave.portal.auth.challenge',
      audience: '/admin',
    })).toThrow('audience');
  });

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

  test('binds capabilities to a stable Host and authenticated principal', () => {
    expect(parsePortalRpcResult('portal.capabilities', {
      protocolVersion: 2,
      hostId: 'host-1',
      displayName: 'Portal',
      principal: {
        principalId: 'principal-1',
        credentialId: 'credential-1',
        label: 'Jaco’s iPad',
      },
      capabilities: ['thread.list'],
    })).toEqual({
      protocolVersion: 2,
      hostId: 'host-1',
      displayName: 'Portal',
      principal: {
        principalId: 'principal-1',
        credentialId: 'credential-1',
        label: 'Jaco’s iPad',
      },
      capabilities: ['thread.list'],
    });
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
