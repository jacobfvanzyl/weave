import { describe, expect, it } from 'vitest';
import { createTerminalPanelTab, useTerminalStore } from '../../packages/client/src/stores/terminal-store';

describe('terminal tab identity', () => {
  it('uses backend tmux window records as deterministic tab identity', () => {
    const tab = createTerminalPanelTab('workspace-1', 1, {
      terminalId: 'weave:terminal:v1:scope:slot:1',
      scopeId: 'scope',
      slot: 1,
      kind: 'workspace',
      cwd: '/repo/workspace',
      title: 'Terminal 1',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      processName: 'nvim',
    });

    expect(tab).toMatchObject({
      id: 'weave:terminal:v1:scope:slot:1',
      terminalId: 'weave:terminal:v1:scope:slot:1',
      scopeId: 'scope',
      slot: 1,
      cwd: '/repo/workspace',
      processName: 'nvim',
      title: 'Terminal 1',
      label: 'Terminal 1',
    });
  });

  it('uses slot-based fallback ids without clocks or counters', () => {
    expect(createTerminalPanelTab('workspace-1', 2)).toMatchObject({
      id: 'workspace-1:slot:2',
      terminalId: 'workspace-1:slot:2',
      slot: 2,
      label: 'Terminal 2',
    });
    expect(createTerminalPanelTab('workspace-1', 2).id).toBe('workspace-1:slot:2');
  });

  it('replaces workspace tabs from tmux windows and preserves valid active ids', () => {
    useTerminalStore.setState({
      activeTerminalTabByTarget: { 'workspace-1': 'weave:terminal:v1:scope:slot:2' },
      terminalTabsByTarget: {},
    });

    useTerminalStore.getState().setTerminalWindows('workspace-1', [
      {
        terminalId: 'weave:terminal:v1:scope:slot:2',
        scopeId: 'scope',
        slot: 2,
        kind: 'workspace',
        cwd: '/repo/workspace',
        title: 'Terminal 2',
        projectId: 'project-1',
        workspaceId: 'workspace-1',
      },
      {
        terminalId: 'weave:terminal:v1:scope:slot:1',
        scopeId: 'scope',
        slot: 1,
        kind: 'workspace',
        cwd: '/repo/workspace',
        title: 'Terminal 1',
        projectId: 'project-1',
        workspaceId: 'workspace-1',
      },
    ]);

    expect(useTerminalStore.getState().terminalTabsByTarget['workspace-1']?.map(tab => tab.terminalId))
      .toEqual(['weave:terminal:v1:scope:slot:1', 'weave:terminal:v1:scope:slot:2']);
    expect(useTerminalStore.getState().activeTerminalTabByTarget['workspace-1'])
      .toBe('weave:terminal:v1:scope:slot:2');
  });

  it('refreshes tmux process names without wiping live tab metadata', () => {
    useTerminalStore.setState({
      activeTerminalTabByTarget: { 'workspace-1': 'weave:terminal:v1:scope:slot:1' },
      terminalTabsByTarget: {
        'workspace-1': [{
          id: 'weave:terminal:v1:scope:slot:1',
          terminalId: 'weave:terminal:v1:scope:slot:1',
          slot: 1,
          cwd: '/repo/workspace',
          title: 'jaco@host:/repo/workspace',
          status: 'running',
          label: 'Terminal 1',
        }],
      },
    });

    useTerminalStore.getState().refreshTerminalWindowMetadata('workspace-1', [
      {
        terminalId: 'weave:terminal:v1:scope:slot:1',
        scopeId: 'scope',
        slot: 1,
        kind: 'workspace',
        cwd: '/repo/workspace',
        title: 'weave-1-abc123',
        processName: 'npm',
        projectId: 'project-1',
        workspaceId: 'workspace-1',
      },
    ]);

    expect(useTerminalStore.getState().terminalTabsByTarget['workspace-1']?.[0]).toMatchObject({
      processName: 'npm',
      title: 'jaco@host:/repo/workspace',
      status: 'running',
    });
  });

  it('does not remove tabs during metadata-only tmux refreshes', () => {
    useTerminalStore.setState({
      activeTerminalTabByTarget: { 'workspace-1': 'weave:terminal:v1:scope:slot:2' },
      terminalTabsByTarget: {
        'workspace-1': [
          {
            id: 'weave:terminal:v1:scope:slot:1',
            terminalId: 'weave:terminal:v1:scope:slot:1',
            slot: 1,
            label: 'Terminal 1',
          },
          {
            id: 'weave:terminal:v1:scope:slot:2',
            terminalId: 'weave:terminal:v1:scope:slot:2',
            slot: 2,
            label: 'Terminal 2',
          },
        ],
      },
    });

    useTerminalStore.getState().refreshTerminalWindowMetadata('workspace-1', [
      {
        terminalId: 'weave:terminal:v1:scope:slot:1',
        scopeId: 'scope',
        slot: 1,
        kind: 'workspace',
        cwd: '/repo/workspace',
        title: 'weave-1-abc123',
        processName: 'npm',
        projectId: 'project-1',
        workspaceId: 'workspace-1',
      },
    ]);

    expect(useTerminalStore.getState().terminalTabsByTarget['workspace-1']?.map(tab => tab.terminalId))
      .toEqual(['weave:terminal:v1:scope:slot:1', 'weave:terminal:v1:scope:slot:2']);
    expect(useTerminalStore.getState().terminalTabsByTarget['workspace-1']?.[0]?.processName).toBe('npm');
    expect(useTerminalStore.getState().activeTerminalTabByTarget['workspace-1'])
      .toBe('weave:terminal:v1:scope:slot:2');
  });

  it('clears stale workspace tabs when tmux has no windows for the target', () => {
    useTerminalStore.setState({
      activeTerminalTabByTarget: { 'workspace-1': 'missing' },
      terminalTabsByTarget: {
        'workspace-1': [{
          id: 'missing',
          terminalId: 'missing',
          slot: 1,
          label: 'Terminal 1',
        }],
      },
    });

    useTerminalStore.getState().setTerminalWindows('workspace-1', []);

    expect(useTerminalStore.getState().terminalTabsByTarget['workspace-1']).toEqual([]);
    expect(useTerminalStore.getState().activeTerminalTabByTarget['workspace-1']).toBeUndefined();
  });

  it('tracks workspace terminal window counts from tmux snapshots', () => {
    useTerminalStore.setState({
      workspaceTerminalWindowCounts: {},
    });

    useTerminalStore.getState().setTerminalSnapshotWindows([
      {
        terminalId: 'weave:terminal:v1:scope-a:slot:1',
        scopeId: 'scope-a',
        slot: 1,
        kind: 'workspace',
        cwd: '/repo/workspace-a',
        title: 'Terminal 1',
        projectId: 'project-1',
        workspaceId: 'workspace-a',
      },
      {
        terminalId: 'weave:terminal:v1:scope-a:slot:2',
        scopeId: 'scope-a',
        slot: 2,
        kind: 'workspace',
        cwd: '/repo/workspace-a',
        title: 'Terminal 2',
        projectId: 'project-1',
        workspaceId: 'workspace-a',
      },
      {
        terminalId: 'weave:terminal:v1:scope-b:slot:1',
        scopeId: 'scope-b',
        slot: 1,
        kind: 'workspace',
        cwd: '/repo/workspace-b',
        title: 'Terminal 1',
        projectId: 'project-1',
        workspaceId: 'workspace-b',
      },
      {
        terminalId: 'weave:terminal:v1:scope-global:slot:1',
        scopeId: 'scope-global',
        slot: 1,
        kind: 'general',
        cwd: '/repo',
        title: 'Terminal 1',
      },
    ]);

    expect(useTerminalStore.getState().workspaceTerminalWindowCounts).toEqual({
      'workspace-a': 2,
      'workspace-b': 1,
    });
  });

  it('updates workspace terminal window counts when a target is reconciled', () => {
    useTerminalStore.setState({
      workspaceTerminalWindowCounts: { 'workspace-1': 3 },
      terminalTabsByTarget: {},
    });

    useTerminalStore.getState().setTerminalWindows('workspace-1', [
      {
        terminalId: 'weave:terminal:v1:scope:slot:1',
        scopeId: 'scope',
        slot: 1,
        kind: 'workspace',
        cwd: '/repo/workspace',
        title: 'Terminal 1',
        projectId: 'project-1',
        workspaceId: 'workspace-1',
      },
    ]);
    expect(useTerminalStore.getState().workspaceTerminalWindowCounts['workspace-1']).toBe(1);

    useTerminalStore.getState().setTerminalWindows('workspace-1', []);
    expect(useTerminalStore.getState().workspaceTerminalWindowCounts['workspace-1']).toBeUndefined();
  });
});
