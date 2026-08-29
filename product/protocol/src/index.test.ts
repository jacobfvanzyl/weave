import { describe, expect, test } from 'bun:test';
import {
  parsePortalAuthChallenge,
  parsePortalAuthenticated,
  parsePortalPairRequest,
  parsePortalPairResult,
  parsePortalRpcParams,
  parsePortalRpcResult,
  parseTerminalNotification,
  parseWorkspaceFileErrorData,
  parseWorkspaceFileWatchNotification,
  PORTAL_ACP_PATH,
  TERMINAL_EVENT_METHOD,
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
    expect(
      parsePortalAuthenticated({
        type: 'weave.portal.auth.authenticated',
        principal: {
          principalId: 'principal-1',
          credentialId: 'credential-1',
          label: 'Jaco’s iPad',
        },
      }).principal,
    ).toEqual({
      principalId: 'principal-1',
      credentialId: 'credential-1',
      label: 'Jaco’s iPad',
    });
    expect(
      parsePortalPairRequest({
        type: 'weave.portal.pair.request',
        token: 'header.payload.signature',
        label: 'Jaco’s iPad',
        publicKey: 'public-key',
      }).token,
    ).toBe('header.payload.signature');
    expect(
      parsePortalPairResult({
        type: 'weave.portal.pair.result',
        hostId: 'host-1',
        displayName: 'Portal',
        principal: {
          principalId: 'principal-1',
          credentialId: 'credential-1',
          label: 'Jaco’s iPad',
        },
      }).hostId,
    ).toBe('host-1');
    expect(() =>
      parsePortalAuthChallenge({
        type: 'weave.portal.auth.challenge',
        audience: '/admin',
      })
    ).toThrow('audience');
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
        connection: {
          path: PORTAL_ACP_PATH,
          threadId: 'thread-1',
          cwd: '/workspace',
        },
      }).connection,
    ).toEqual({ path: '/acp', threadId: 'thread-1', cwd: '/workspace' });
  });

  test('parses provisional Thread lifecycle requests and results', () => {
    expect(parsePortalRpcParams('thread.draft.create', {
      workspaceId: 'weave',
      agentId: 'codex',
    })).toEqual({ workspaceId: 'weave', agentId: 'codex' });
    expect(parsePortalRpcParams('thread.draft.discard', {
      threadId: 'draft-1',
    })).toEqual({ threadId: 'draft-1' });
    expect(
      parsePortalRpcResult('thread.draft.create', {
        thread: {
          threadId: 'draft-1',
          agentId: 'codex',
          workspaceId: 'weave',
          acpSessionId: 'session-1',
          status: 'active',
          createdAt: '2026-08-28T00:00:00.000Z',
          updatedAt: '2026-08-28T00:00:00.000Z',
        },
      }).thread.acpSessionId,
    ).toBe('session-1');
    expect(parsePortalRpcResult('thread.draft.discard', {
      discarded: true,
    })).toEqual({ discarded: true });
  });

  test('parses host-local project removal requests and results', () => {
    expect(parsePortalRpcParams('workspace.remove', {
      workspaceId: 'workspace-1',
    })).toEqual({ workspaceId: 'workspace-1' });
    expect(parsePortalRpcResult('workspace.remove', { removed: true }))
      .toEqual({ removed: true });
    expect(() => parsePortalRpcResult('workspace.remove', { removed: false }))
      .toThrow('workspace.remove');
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

  test('parses project registration and Git repository identity', () => {
    expect(parsePortalRpcParams('workspace.add', {
      path: '/srv/projects/weave',
      name: 'Weave',
    })).toEqual({ path: '/srv/projects/weave', name: 'Weave' });
    expect(
      parsePortalRpcResult('workspace.add', {
        workspace: {
          workspaceId: 'workspace-1',
          name: 'Weave',
          rootName: 'weave',
          repositoryIdentity: {
            canonicalKey: 'github.com/veezee/weave',
            locator: {
              source: 'git-remote',
              remoteName: 'origin',
              remoteUrl: 'git@github.com:VeeZee/weave.git',
            },
            displayName: 'veezee/weave',
            name: 'weave',
          },
        },
      }).workspace,
    ).toMatchObject({
      rootName: 'weave',
      repositoryIdentity: { canonicalKey: 'github.com/veezee/weave' },
    });
    expect(() => parsePortalRpcParams('workspace.add', { path: '' })).toThrow(
      'path',
    );
  });

  test('rejects malformed Thread state', () => {
    expect(() => parsePortalRpcResult('thread.list', { threads: [{ status: 'maybe' }] })).toThrow();
    expect(() => parsePortalRpcParams('thread.list', { status: 'deleted' }))
      .toThrow();
    expect(parsePortalRpcParams('thread.list', { status: 'archived' })).toEqual(
      { status: 'archived' },
    );
    expect(
      parsePortalRpcResult('thread.archive', {
        thread: {
          threadId: 'thread-1',
          agentId: 'codex',
          workspaceId: 'weave',
          acpSessionId: 'session-1',
          status: 'archived',
          createdAt: '2026-08-26T00:00:00.000Z',
          updatedAt: '2026-08-26T01:00:00.000Z',
          archivedAt: '2026-08-26T01:00:00.000Z',
        },
      }).thread.status,
    ).toBe('archived');
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
        matches: [{
          path: 'src/main.ts',
          kind: 'content',
          line: 1,
          preview: 'export {};',
        }],
        truncated: false,
      }),
    ).toEqual({
      path: '',
      matches: [{
        path: 'src/main.ts',
        kind: 'content',
        line: 1,
        preview: 'export {};',
      }],
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

  test('routes Terminal contracts through the Portal protocol', () => {
    expect(parsePortalRpcParams('terminal.list', {
      workspaceId: 'workspace-1',
    })).toEqual({ workspaceId: 'workspace-1' });
    expect(
      parsePortalRpcResult('terminal.create', {
        terminal: {
          terminalId: 'terminal-1',
          workspaceId: 'workspace-1',
          title: 'zsh',
          status: 'running',
          cols: 80,
          rows: 24,
        },
      }).terminal.terminalId,
    ).toBe('terminal-1');
    expect(
      parseTerminalNotification(TERMINAL_EVENT_METHOD, {
        attachmentId: 'attachment-1',
        terminalId: 'terminal-1',
        workspaceId: 'workspace-1',
        generation: 'generation-1',
        sequence: 1,
        event: { type: 'output', data: 'ready' },
      }).event,
    ).toEqual({ type: 'output', data: 'ready' });
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
