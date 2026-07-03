import { afterEach, describe, expect, it } from 'vitest';
import {
  connectWorkspaceFileWatchRelayClient,
  disconnectWorkspaceFileWatchRelayClient,
  forwardWorkspaceFileWatchClientMessage,
  handleWorkspaceFileWatchPortalMessage,
  issueWorkspaceFileWatchToken,
} from '../../server/src/portal/workspace-file-watch-relay';
import { connectPortal, disconnectPortal } from '../../server/src/portal/registry';

const connectedPortalIds: string[] = [];

const connectTestPortal = (portalId: string, sent: unknown[]) => {
  connectedPortalIds.push(portalId);
  connectPortal({
    portalId,
    userId: 'user-1',
    capabilities: ['portal.fs.watch'],
    mounts: [],
    roots: [],
    ws: {
      send: data => sent.push(JSON.parse(data)),
      close: () => undefined,
    },
  });
};

describe('workspace file watch relay', () => {
  afterEach(() => {
    connectedPortalIds.splice(0).forEach(portalId => disconnectPortal(portalId));
  });

  it('sanitizes watch messages and forwards Portal events', () => {
    const portalMessages: unknown[] = [];
    const clientMessages: unknown[] = [];
    connectTestPortal('portal-1', portalMessages);
    const token = issueWorkspaceFileWatchToken({
      resourceId: 'user-1',
      portalId: 'portal-1',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      rootId: 'default',
      repoPath: 'repo',
      workspacePath: '/workspace',
    });
    const connected = connectWorkspaceFileWatchRelayClient({
      token,
      ws: {
        send: data => clientMessages.push(JSON.parse(data)),
        close: () => undefined,
      },
    });

    expect(connected?.clientId).toMatch(/^relay-workspace-file-watch:/);
    expect(connectWorkspaceFileWatchRelayClient({
      token,
      ws: {
        send: () => undefined,
        close: () => undefined,
      },
    })).toBeUndefined();

    forwardWorkspaceFileWatchClientMessage(connected!.clientId, {
      type: 'watch.start',
      requestId: 'start-1',
      target: { workspacePath: '/evil' },
      paths: ['src'],
    });
    expect(portalMessages.at(-1)).toEqual({
      type: 'workspace-file.watch.client',
      clientId: connected!.clientId,
      message: {
        type: 'watch.start',
        requestId: 'start-1',
        target: {
          projectId: 'project-1',
          workspaceId: 'workspace-1',
          portalId: 'portal-1',
          rootId: 'default',
          repoPath: 'repo',
          workspacePath: '/workspace',
        },
        paths: ['src'],
      },
    });

    expect(() =>
      forwardWorkspaceFileWatchClientMessage(connected!.clientId, {
        type: 'watch.update',
        paths: ['../outside'],
      })
    ).toThrow('escape');

    expect(handleWorkspaceFileWatchPortalMessage({
      type: 'workspace-file.watch.event',
      clientId: connected!.clientId,
      event: { type: 'workspace-file.watch.ready', requestId: 'start-1', paths: ['src'] },
    })).toBe(true);
    expect(clientMessages).toEqual([
      { type: 'workspace-file.watch.ready', requestId: 'start-1', paths: ['src'] },
    ]);

    disconnectWorkspaceFileWatchRelayClient(connected!.clientId);
    expect(portalMessages.at(-1)).toEqual({
      type: 'workspace-file.watch.client',
      clientId: connected!.clientId,
      message: { type: 'watch.stop' },
    });
  });
});
