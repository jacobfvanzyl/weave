import { describe, expect, test } from 'bun:test';
import {
  parseBrowserControlCommand,
  parseBrowserProviderAttachParams,
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
  test('preserves exact Host context paths and accepts legacy summaries without guessing', () => {
    const summary = { executionContextId: 'workspace-1', name: 'Checkout' };
    for (const canonicalPath of ['/', '/Users/Jaco/Code', '/home/jaco/worktree']) {
      expect(parsePortalRpcResult('context.list', {
        executionContexts: [{ ...summary, canonicalPath }],
      }).executionContexts[0]).toEqual({ ...summary, canonicalPath });
    }
    expect(parsePortalRpcResult('context.list', { executionContexts: [summary] }).executionContexts[0])
      .toEqual(summary);
    for (const canonicalPath of ['', 'relative', '/work/../other', '/work/./tree', '/work//tree', '/work/', '/work\0hidden']) {
      expect(() => parsePortalRpcResult('context.add', {
        workspace: { ...summary, canonicalPath },
      })).toThrow('context.canonicalPath');
    }
  });
  test('parses the bounded visible Browser capability and ergonomic commands', () => {
    expect(parseBrowserProviderAttachParams({
      threadId: 'thread-1',
      offer: {
        version: 1,
        clientId: 'alpha-ipad',
        workspaceId: 'visible-tab',
        generation: 2,
        controlRevision: 4,
        platform: 'iPadOS',
        operations: ['see', 'act'],
        authorization: { observe: true, control: true },
        limits: {
          maxResultBytes: 65536,
          maxScreenshotBytes: 1500000,
          maxElements: 200,
          maxDurationMs: 30000,
        },
      },
    }).offer.workspaceId).toBe('visible-tab');
    expect(parseBrowserControlCommand({
      kind: 'act',
      viewId: 'view-1',
      action: { kind: 'fill', target: 'view-1:0', text: 'WVE-57' },
      expect: { kind: 'text', text: 'submitted' },
      screenshot: true,
    })).toEqual({
      kind: 'act',
      viewId: 'view-1',
      action: { kind: 'fill', target: 'view-1:0', text: 'WVE-57' },
      expect: { kind: 'text', text: 'submitted' },
      screenshot: true,
    });
    expect(() => parseBrowserControlCommand({
      kind: 'act',
      viewId: 'view-1',
      action: { kind: 'evaluate', script: 'document.cookie' },
    })).toThrow('action.kind is invalid');
  });
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
          executionContextId: 'weave',
          workspaceId: 'workspace', membershipRevision: 0, acpSessionId: 'session-1',
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
    expect(parsePortalRpcParams('thread.draft.create', { workspaceId: 'workspace',
      executionContextId: 'weave',
      agentId: 'codex',
    })).toEqual({ workspaceId: 'workspace', executionContextId: 'weave', agentId: 'codex' });
    expect(parsePortalRpcParams('thread.draft.discard', {
      threadId: 'draft-1',
    })).toEqual({ threadId: 'draft-1' });
    expect(
      parsePortalRpcResult('thread.draft.create', {
        thread: {
          threadId: 'draft-1',
          agentId: 'codex',
          executionContextId: 'weave',
          workspaceId: 'workspace', membershipRevision: 0, acpSessionId: 'session-1',
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
    expect(parsePortalRpcParams('context.remove', {
      executionContextId: 'workspace-1',
    })).toEqual({ executionContextId: 'workspace-1' });
    expect(parsePortalRpcResult('context.remove', { removed: true }))
      .toEqual({ removed: true });
    expect(() => parsePortalRpcResult('context.remove', { removed: false }))
      .toThrow('context.remove');
  });

  test('binds capabilities to a stable Host and authenticated principal', () => {
    expect(parsePortalRpcResult('portal.capabilities', {
      protocolVersion: 6,
      hostId: 'host-1',
      displayName: 'Portal',
      principal: {
        principalId: 'principal-1',
        credentialId: 'credential-1',
        label: 'Jaco’s iPad',
      },
      capabilities: ['thread.list'],
    })).toEqual({
      protocolVersion: 6,
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
    expect(parsePortalRpcParams('context.add', {
      path: '/srv/projects/weave',
      name: 'Weave',
    })).toEqual({ path: '/srv/projects/weave', name: 'Weave' });
    expect(
      parsePortalRpcResult('context.add', {
        workspace: {
          executionContextId: 'workspace-1',
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
    expect(() => parsePortalRpcParams('context.add', { path: '' })).toThrow(
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
          executionContextId: 'weave',
          workspaceId: 'workspace', membershipRevision: 0, acpSessionId: 'session-1',
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
      parsePortalRpcParams('context.file.write', {
        executionContextId: 'weave',
        path: 'src/main.ts',
        content: 'export {};\n',
        expectedContentHash: '0'.repeat(64),
      }),
    ).toEqual({
      executionContextId: 'weave',
      path: 'src/main.ts',
      content: 'export {};\n',
      expectedContentHash: '0'.repeat(64),
    });

    expect(
      parsePortalRpcResult('context.file.search', {
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
      parsePortalRpcParams('context.file.search', {
        executionContextId: 'weave',
        path: '',
        query: 'x'.repeat(257),
        scope: 'both',
      })
    ).toThrow('256');
  });

  test('routes Terminal contracts through the Portal protocol', () => {
    expect(parsePortalRpcParams('terminal.list', {
      executionContextId: 'workspace-1',
    })).toEqual({ executionContextId: 'workspace-1' });
    expect(
      parsePortalRpcResult('terminal.create', {
        terminal: {
          terminalId: 'terminal-1',
          executionContextId: 'workspace-1',
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
        executionContextId: 'workspace-1',
        generation: 'generation-1',
        sequence: 1,
        event: { type: 'output', data: new TextEncoder().encode('ready') },
      }).event,
    ).toEqual({ type: 'output', data: new TextEncoder().encode('ready') });
  });

  test('requires conditional writes and validates watch notifications and typed errors', () => {
    expect(() =>
      parsePortalRpcParams('context.file.write', {
        executionContextId: 'weave',
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

test('Thread attention carries freshness separately from archive lifecycle and accepts older Hosts', () => {
  const thread = { threadId: 'thread', executionContextId: 'workspace', agentId: 'agent', workspaceId: 'workspace', membershipRevision: 0, acpSessionId: 'session', status: 'active', createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z' };
  const result = (attention?: unknown) => parsePortalRpcResult('thread.list', { threads: [{ ...thread, ...(attention === undefined ? {} : { attention }) }] }).threads[0];
  expect(result()).toEqual(thread);
  for (const state of ['working', 'waiting', 'completed', 'idle', 'unavailable', 'uncertain']) {
    const attention = { state, observedAt: '2026-09-09T10:00:00Z', generation: 1 };
    expect(result(attention)).toEqual({ ...thread, attention });
  }
  for (const uncertaintyReason of ['runtime_not_loaded', 'prompt_outcome_unknown']) {
    const attention = { state: 'uncertain', observedAt: thread.createdAt, uncertaintyReason };
    expect(result(attention)?.attention).toEqual(attention);
  }
  expect(() => result({ state: 'uncertain', observedAt: thread.createdAt, uncertaintyReason: 'unknown' })).toThrow('thread.attention');
  expect(() => result({ state: 'idle', observedAt: thread.createdAt, uncertaintyReason: 'runtime_not_loaded' })).toThrow('thread.attention');
  for (const attention of [{ state: 'archived', observedAt: thread.createdAt }, { state: 'idle', observedAt: 'invalid' }, { state: 'idle', observedAt: thread.createdAt, generation: -1 }]) expect(() => result(attention)).toThrow('thread.attention');
});


test('Workspace directory availability preserves canonical identity and rejects unknown states', () => {
  const workspace = { executionContextId: 'old-id', name: 'Checkout', canonicalPath: '/code/checkout' };
  for (const availability of ['available', 'unavailable', 'path-changed']) {
    expect(parsePortalRpcResult('context.list', { executionContexts: [{ ...workspace, availability }] }).executionContexts[0]).toEqual({ ...workspace, availability });
  }
  expect(() => parsePortalRpcResult('context.list', { executionContexts: [{ ...workspace, availability: 'connected' }] })).toThrow('context.availability');
});


test('requires stored Thread membership and rejects null creation or move targets', () => {
  const creation = { executionContextId: 'context', agentId: 'agent' };
  expect(parsePortalRpcParams('thread.create', creation)).toEqual(creation);
  for (const method of ['thread.create', 'thread.draft.create'] as const) {
    expect(() => parsePortalRpcParams(method, { ...creation, workspaceId: null })).toThrow();
  }
  expect(() => parsePortalRpcParams('thread.assign', { threadId: 'thread', hostId: 'host', workspaceId: null, expectedRevision: 0 })).toThrow();
  const record = { threadId: 'thread', executionContextId: 'context', agentId: 'agent', acpSessionId: 'session', status: 'active', createdAt: '2026-09-10', updatedAt: '2026-09-10', membershipRevision: 0 };
  for (const workspaceId of [undefined, null, '']) expect(() => parsePortalRpcResult('thread.list', { threads: [{ ...record, workspaceId }] })).toThrow();
  expect(() => parsePortalRpcResult('portal.capabilities', { protocolVersion: 3 })).toThrow();
});
