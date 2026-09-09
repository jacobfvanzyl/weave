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

});
