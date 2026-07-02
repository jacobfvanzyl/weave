import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatThread, ThreadPlan, ThreadProposal } from '../../packages/client/src/stores/chat-store';

const createStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
};

const loadFreshChatStore = async (seed?: (storage: Storage) => void) => {
  vi.resetModules();
  const storage = createStorage();
  seed?.(storage);
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', {
    localStorage: storage,
    location: { protocol: 'http:', hostname: 'localhost' },
  });
  return import('../../packages/client/src/stores/chat-store');
};

describe('chat store', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('defaults follow writes off and persists setting updates', async () => {
    const { useChatStore } = await loadFreshChatStore();

    expect(useChatStore.getState().followWrites).toBe(false);
    useChatStore.getState().setFollowWrites(true);
    expect(useChatStore.getState().followWrites).toBe(true);
  });

  it('migrates persisted chat settings with follow writes defaulting off', async () => {
    const { useChatStore } = await loadFreshChatStore(storage => {
      storage.setItem('weave-chat', JSON.stringify({
        state: {
          selectedModel: 'openai/test',
          reasoningEffort: 'xhigh',
          serviceTier: 'fast',
          showToolCalls: false,
          showReasoning: false,
          showPlanPanel: false,
          toolActivityCollapsed: { 'message-1:0': true },
        },
        version: 11,
      }));
    });

    expect(useChatStore.getState()).toMatchObject({
      selectedModel: 'openai/test',
      reasoningEffort: 'xhigh',
      serviceTier: 'priority',
      followWrites: false,
      showToolCalls: false,
      showReasoning: false,
      showPlanPanel: false,
      toolActivityCollapsed: { 'message-1:0': true },
    });
  });

  it('migrates legacy persisted reasoning aliases to the fastest current effort', async () => {
    for (const reasoningEffort of ['off', 'minimal']) {
      const { useChatStore } = await loadFreshChatStore(storage => {
        storage.setItem('weave-chat', JSON.stringify({
          state: {
            selectedModel: 'openai/gpt-5.5',
            reasoningEffort,
          },
          version: 11,
        }));
      });

      expect(useChatStore.getState().reasoningEffort).toBe('low');
    }
  });

  it('queues and consumes proposal implementation requests without persisting them', async () => {
    const { useChatStore } = await loadFreshChatStore();
    const request = useChatStore.getState().enqueueProposalImplementationRequest('thread-1', {
      proposalPath: '.agents/proposals/demo.md',
      approvedItemIds: ['item-1', 'item-2'],
      requestedAt: '2026-06-28T12:00:00.000Z',
    });

    expect(request).toMatchObject({
      proposalPath: '.agents/proposals/demo.md',
      approvedItemIds: ['item-1', 'item-2'],
      requestedAt: '2026-06-28T12:00:00.000Z',
    });
    expect(useChatStore.getState().pendingProposalImplementationRequests['thread-1']).toEqual(request);
    expect(useChatStore.getState().guidedTaskExpandedByThread['thread-1']).toBe(true);

    useChatStore.getState().consumeProposalImplementationRequest('thread-1', 'wrong-id');
    expect(useChatStore.getState().pendingProposalImplementationRequests['thread-1']).toEqual(request);

    useChatStore.getState().consumeProposalImplementationRequest('thread-1', request.id);
    expect(useChatStore.getState().pendingProposalImplementationRequests['thread-1']).toBeUndefined();
  });

  it('keeps a submitted proposal marker after the queued implementation request is consumed', async () => {
    const { useChatStore } = await loadFreshChatStore();
    const proposal: ThreadProposal = {
      path: '.agents/proposals/demo.md',
      items: [
        { id: 'item-1', kind: 'file_edit', status: 'pending', title: 'Update file', additions: 1, deletions: 0, viewed: false },
      ],
      counts: { pending: 1 },
      updatedAt: '2026-06-18T12:00:00.000Z',
      contentHash: 'proposal-hash-1',
    };
    useChatStore.getState().setThreadProposal('thread-1', proposal);

    const request = useChatStore.getState().enqueueProposalImplementationRequest('thread-1', {
      proposalPath: '.agents/proposals/demo.md',
      approvedItemIds: ['item-1'],
      mode: 'implement',
      requestedAt: '2026-06-28T12:00:00.000Z',
    });

    expect(useChatStore.getState().submittedProposalImplementations['thread-1']).toMatchObject({
      requestId: request.id,
      proposalPath: '.agents/proposals/demo.md',
      proposalContentHash: 'proposal-hash-1',
      mode: 'implement',
    });

    useChatStore.getState().consumeProposalImplementationRequest('thread-1', request.id);
    expect(useChatStore.getState().submittedProposalImplementations['thread-1']?.requestId).toBe(request.id);
  });

  it('clears the submitted proposal marker when a revised proposal artifact arrives', async () => {
    const { useChatStore } = await loadFreshChatStore();
    const proposal: ThreadProposal = {
      path: '.agents/proposals/demo.md',
      items: [
        { id: 'item-1', kind: 'file_edit', status: 'pending', title: 'Update file', additions: 1, deletions: 0, viewed: false },
      ],
      counts: { pending: 1 },
      updatedAt: '2026-06-18T12:00:00.000Z',
      contentHash: 'proposal-hash-1',
    };
    useChatStore.getState().setThreadProposal('thread-1', proposal);
    useChatStore.getState().enqueueProposalImplementationRequest('thread-1', {
      proposalPath: '.agents/proposals/demo.md',
      approvedItemIds: ['item-1'],
      mode: 'address_feedback',
    });

    useChatStore.getState().setThreadProposal('thread-1', {
      ...proposal,
      contentHash: 'proposal-hash-1',
      updatedAt: '2026-06-18T12:01:00.000Z',
    }, { autoExpand: false });
    expect(useChatStore.getState().submittedProposalImplementations['thread-1']).toBeDefined();

    useChatStore.getState().setThreadProposal('thread-1', {
      ...proposal,
      contentHash: 'proposal-hash-2',
      updatedAt: '2026-06-18T12:02:00.000Z',
    }, { autoExpand: false });
    expect(useChatStore.getState().submittedProposalImplementations['thread-1']).toBeUndefined();
  });

  it('collapses the guided card when implementation is queued', async () => {
    const { useChatStore } = await loadFreshChatStore();
    useChatStore.getState().setGuidedTaskExpanded('thread-1', true);

    useChatStore.getState().enqueueProposalImplementationRequest('thread-1', {
      proposalPath: '.agents/proposals/demo.md',
      approvedItemIds: ['item-1'],
      mode: 'implement',
    });

    expect(useChatStore.getState().guidedTaskExpandedByThread['thread-1']).toBe(false);
  });

  it('expands the guided card when a plan completes live', async () => {
    const { useChatStore } = await loadFreshChatStore();
    const basePlan: ThreadPlan = {
      title: 'Plan Artifact Overhaul',
      plan: [
        { id: 'research', step: 'Research current plan tooling', status: 'completed' },
        { id: 'implement', step: 'Implement artifact-aware plan tools', status: 'pending' },
      ],
      completed: 1,
      total: 2,
      updatedAt: '2026-06-18T12:00:00.000Z',
      contentHash: 'pending',
    };

    useChatStore.getState().setThreadPlan('thread-1', basePlan);
    expect(useChatStore.getState().guidedTaskExpandedByThread['thread-1']).toBe(false);

    useChatStore.getState().setThreadPlan('thread-1', {
      ...basePlan,
      status: 'completed',
      plan: basePlan.plan.map(item => ({ ...item, status: 'completed' })),
      completed: 2,
      contentHash: 'complete',
    });

    expect(useChatStore.getState().guidedTaskExpandedByThread['thread-1']).toBe(true);

    useChatStore.getState().setGuidedTaskExpanded('thread-1', false);
    useChatStore.getState().setThreadPlan('thread-1', {
      ...basePlan,
      status: 'completed',
      plan: basePlan.plan.map(item => ({ ...item, status: 'completed' })),
      completed: 2,
      contentHash: 'complete',
    });

    expect(useChatStore.getState().guidedTaskExpandedByThread['thread-1']).toBe(false);
  });

  it('does not expand the guided card for replayed complete plan effects', async () => {
    const { useChatStore } = await loadFreshChatStore();
    useChatStore.getState().setGuidedTaskExpanded('thread-1', false);

    useChatStore.getState().setThreadPlan('thread-1', {
      title: 'Plan Artifact Overhaul',
      status: 'completed',
      plan: [
        { id: 'research', step: 'Research current plan tooling', status: 'completed' },
        { id: 'implement', step: 'Implement artifact-aware plan tools', status: 'completed' },
      ],
      completed: 2,
      total: 2,
      updatedAt: '2026-06-18T12:00:00.000Z',
      contentHash: 'complete',
    }, { autoExpand: false });

    expect(useChatStore.getState().guidedTaskExpandedByThread['thread-1']).toBe(false);
  });

  it('does not expand the guided card for replayed proposal effects', async () => {
    const { useChatStore } = await loadFreshChatStore();
    useChatStore.getState().setGuidedTaskExpanded('thread-1', false);

    useChatStore.getState().setThreadProposal('thread-1', {
      title: 'Proposal review',
      path: '.agents/proposals/demo.md',
      status: 'ready',
      items: [
        { id: 'item-1', kind: 'file_edit', status: 'pending', title: 'Update file', additions: 1, deletions: 0, viewed: false },
      ],
      counts: { pending: 1 },
      updatedAt: '2026-06-18T12:00:00.000Z',
      contentHash: 'proposal',
    }, { autoExpand: false });

    expect(useChatStore.getState().guidedTaskExpandedByThread['thread-1']).toBe(false);
  });

  it('collapses the guided card when returning to a thread', async () => {
    const { useChatStore } = await loadFreshChatStore();
    const now = '2026-06-18T12:00:00.000Z';
    const thread = (id: string): ChatThread => ({
      id,
      title: id,
      createdAt: now,
      updatedAt: now,
    });

    useChatStore.setState({ threads: [thread('thread-1'), thread('thread-2')] });
    useChatStore.getState().selectThread('thread-2');
    useChatStore.getState().setGuidedTaskExpanded('thread-1', true);

    useChatStore.getState().selectThread('thread-1');

    expect(useChatStore.getState().guidedTaskExpandedByThread['thread-1']).toBe(false);
  });
});
