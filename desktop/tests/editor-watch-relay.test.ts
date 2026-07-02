import { afterEach, describe, expect, it } from 'vitest';
import {
  connectEditorWatchRelayClient,
  disconnectEditorWatchRelayClient,
  forwardEditorWatchClientMessage,
  handleEditorWatchPortalMessage,
  issueEditorWatchToken,
} from '../../server/src/portal/editor-watch-relay';
import { connectPortal, disconnectPortal } from '../../server/src/portal/registry';

const connectedPortalIds: string[] = [];

const connectTestPortal = (portalId: string, sent: unknown[]) => {
  connectedPortalIds.push(portalId);
  connectPortal({
    portalId,
    userId: 'user-1',
    capabilities: ['portal.editor.watch'],
    mounts: [],
    roots: [],
    ws: {
      send: data => sent.push(JSON.parse(data)),
      close: () => undefined,
    },
  });
};

describe('editor watch relay', () => {
  afterEach(() => {
    connectedPortalIds.splice(0).forEach(portalId => disconnectPortal(portalId));
  });

  it('sanitizes watch messages and forwards Portal events', () => {
    const portalMessages: unknown[] = [];
    const clientMessages: unknown[] = [];
    connectTestPortal('portal-1', portalMessages);
    const token = issueEditorWatchToken({
      resourceId: 'user-1',
      portalId: 'portal-1',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      rootId: 'default',
      repoPath: 'repo',
      workspacePath: '/workspace',
    });
    const connected = connectEditorWatchRelayClient({
      token,
      ws: {
        send: data => clientMessages.push(JSON.parse(data)),
        close: () => undefined,
      },
    });

    expect(connected?.clientId).toMatch(/^relay-editor-watch:/);
    expect(connectEditorWatchRelayClient({
      token,
      ws: {
        send: () => undefined,
        close: () => undefined,
      },
    })).toBeUndefined();

    forwardEditorWatchClientMessage(connected!.clientId, {
      type: 'watch.start',
      requestId: 'start-1',
      target: { workspacePath: '/evil' },
      paths: ['src'],
    });
    expect(portalMessages.at(-1)).toEqual({
      type: 'editor.watch.client',
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
      forwardEditorWatchClientMessage(connected!.clientId, {
        type: 'watch.update',
        paths: ['../outside'],
      })
    ).toThrow('escape');

    expect(handleEditorWatchPortalMessage({
      type: 'editor.watch.event',
      clientId: connected!.clientId,
      event: { type: 'editor.watch.ready', requestId: 'start-1', paths: ['src'] },
    })).toBe(true);
    expect(clientMessages).toEqual([
      { type: 'editor.watch.ready', requestId: 'start-1', paths: ['src'] },
    ]);

    disconnectEditorWatchRelayClient(connected!.clientId);
    expect(portalMessages.at(-1)).toEqual({
      type: 'editor.watch.client',
      clientId: connected!.clientId,
      message: { type: 'watch.stop' },
    });
  });
});

