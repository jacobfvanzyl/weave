import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useMockAlphaController } from './use-mock-alpha-controller';

describe('useMockAlphaController', () => {
  it('models the busy scenario as an active ACP turn that can be cancelled', () => {
    const { result } = renderHook(() => useMockAlphaController('busy'));

    expect(result.current.model.transcript?.turn).toEqual({ status: 'running' });

    act(() => result.current.actions.cancelPrompt());

    expect(result.current.model.transcript?.turn).toEqual({
      status: 'stopped',
      stopReason: 'cancelled',
    });
  });

  it('starts a real mock turn when a prompt is submitted', () => {
    const { result } = renderHook(() => useMockAlphaController('chat'));

    act(() => result.current.actions.sendPrompt('Exercise streaming'));

    expect(result.current.model.transcript?.turn).toEqual({ status: 'running' });
    expect(result.current.model.transcript?.entries.at(-1)).toMatchObject({
      kind: 'message',
      role: 'user',
      optimistic: true,
    });
  });

  it('keeps the active Thread selected while browsing its Workspace without a Host', async () => {
    const { result } = renderHook(() => useMockAlphaController('chat'));

    expect(result.current.model.selectedThreadId).toBe('thread-wve-47');
    expect(result.current.model.workspaceFiles?.directories['']?.entries.map((entry) => entry.path)).toEqual([
      'src',
      'README.md',
    ]);

    await act(async () => result.current.actions.openWorkspaceDirectory('src'));
    expect(result.current.model.workspaceFiles?.directories.src?.entries.map((entry) => entry.path)).toEqual([
      'src/main.ts',
    ]);
    expect(result.current.model.workspaceFiles?.directories['']?.entries.map((entry) => entry.path)).toEqual([
      'src',
      'README.md',
    ]);

    await act(async () => result.current.actions.openWorkspaceFile('src/main.ts'));
    expect(result.current.model.workspaceFiles?.openFiles[0]).toMatchObject({
      kind: 'text',
      path: 'src/main.ts',
      content: expect.stringContaining('WVE42_MOCK_WORKSPACE'),
    });
    expect(result.current.model.workspaceFiles?.activeFilePath).toBe('src/main.ts');
    expect(result.current.model.selectedThreadId).toBe('thread-wve-47');
  });
});
