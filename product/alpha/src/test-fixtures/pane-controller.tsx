import { useState } from 'react';
import { vi } from 'vitest';
import { paneTargets, type Workspace, type PaneLayoutNode } from '@weave/product-protocol';
import type { AlphaController, AlphaThread } from '@/app/alpha-controller';
import { activateWorkspace, emptyWorkspacePresentation, workspaceKey } from '@/app/workspace-presentation';
import { createTranscript } from '@/chat/acp-transcript';

export const terminal = (id: string): PaneLayoutNode => ({ kind: 'terminal', nodeId: `node-${id}`, paneId: id, terminalId: id, executionContextId: 'context' });
export const agent = (id: string): PaneLayoutNode => ({ kind: 'agent', nodeId: `node-${id}`, paneId: id, threadId: id });
export const split = (id: string, left: PaneLayoutNode, right: PaneLayoutNode): PaneLayoutNode => ({ kind: 'split', nodeId: id, axis: 'horizontal', ratio: .5, children: [left, right] });
export function usePaneFixture(platform = 'electron') {
  const initial: Workspace[] = [
    { workspaceId: 'work', name: 'Work', layout: split('root', terminal('shell'), split('agents', agent('first'), agent('second'))) },
    { workspaceId: 'other', name: 'Other', layout: agent('third') },
  ];
  const [workspaces, setWorkspaces] = useState(initial);
  const [presentation, setPresentation] = useState(() => ({ ...activateWorkspace(activateWorkspace(emptyWorkspacePresentation(), { hostId: 'host', workspaceId: 'other' }), { hostId: 'host', workspaceId: 'work' }), focusedPanes: { [workspaceKey({ hostId: 'host', workspaceId: 'work' })]: 'shell' } }));
  const [transcripts] = useState(() => Object.fromEntries(['first', 'second', 'third'].map(id => [id, createTranscript(id)])));
  const [send] = useState(() => vi.fn()), [archive] = useState(() => vi.fn()), [attach] = useState(() => vi.fn(async () => {}));
  const threads: AlphaThread[] = workspaces.flatMap(workspace => paneTargets([workspace]).filter(pane => pane.kind === 'agent').map(pane => ({ id: pane.threadId, threadId: pane.threadId, title: pane.threadId, hostId: 'host', hostName: 'Host', workspaceId: workspace.workspaceId, executionContextId: 'context', status: 'active', updatedAt: '', agentName: 'Agent', supportsThreadLifecycle: true, attention: { state: 'idle', observedAt: new Date().toISOString() } })));
  const focus = (ref: { hostId: string; workspaceId: string }, paneId: string) => setPresentation(value => ({ ...activateWorkspace(value, ref), focusedPanes: { ...value.focusedPanes, [workspaceKey(ref)]: paneId }, maximizedPanes: value.maximizedPanes[workspaceKey(ref)] ? { ...value.maximizedPanes, [workspaceKey(ref)]: paneId } : value.maximizedPanes }));
  const actions = {
    selectThread: async (id: string) => { const thread = threads.find(thread => thread.id === id)!; focus({ hostId: 'host', workspaceId: thread.workspaceId! }, id); },
    archiveThread: async (id: string, stopActive?: boolean) => {
      archive(id, stopActive);
      const prune = (node: PaneLayoutNode | null): PaneLayoutNode | null => {
        if (!node) return null;
        if (node.kind !== 'split') return node.paneId === id ? null : node;
        const left = prune(node.children[0]), right = prune(node.children[1]);
        return left && right ? { ...node, children: [left, right] } : left ?? right;
      };
      setWorkspaces(current => current.map(workspace => ({ ...workspace, layout: prune(workspace.layout) })));
    },
    setFocusedAgentThread: vi.fn(), openConnections: vi.fn(), sendPrompt: vi.fn(),
  };
  const controller = { model: {
    platform, connections: [{ hostId: 'host', displayName: 'Host', status: 'connected' }], connection: {},
    executionContexts: [{ id: 'context', executionContextId: 'context', hostId: 'host', canonicalPath: '/project', availability: 'available' }],
    threads, archivedThreads: [], busy: false, connectionsLoaded: true,
    workspaceCompositions: { presentation, compositions: { host: { schemaVersion: 3, hostId: 'host', revision: 1, workspaces } }, terminals: { host: [{ terminalId: 'shell', title: 'Shell', executionContextId: 'context', currentDirectory: '/project' }] } },
  }, attachThread: attach, actions, workspaceActions: {
    activate: (ref: { hostId: string; workspaceId: string }) => setPresentation(value => activateWorkspace(value, ref)), focus,
    maximize: (ref: { hostId: string; workspaceId: string }, paneId: string) => setPresentation(value => ({ ...value, maximizedPanes: value.maximizedPanes[workspaceKey(ref)] ? {} : { [workspaceKey(ref)]: paneId } })),
    refresh: vi.fn(async () => {}),
  } } as unknown as AlphaController;
  controller.forThread = id => ({ ...controller, model: { ...controller.model, selectedThreadId: id, transcript: transcripts[id] }, actions: { ...controller.actions, sendPrompt: text => { send(id, text); } } });
  return { controller, send, archive, attach };
}
