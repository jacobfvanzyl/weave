import { describe, expect, it } from 'vitest';
import { parseWorkspaceFileWatchStopInput } from '../src/main/workspace-file-input';

describe('workspace file input parsing', () => {
  it('accepts workspace file watch stop payloads from preload', () => {
    expect(parseWorkspaceFileWatchStopInput({ subscriptionId: 'sub-1' })).toBe('sub-1');
  });

  it('accepts direct workspace file watch stop subscription ids', () => {
    expect(parseWorkspaceFileWatchStopInput('sub-1')).toBe('sub-1');
  });

  it('rejects missing workspace file watch stop subscription ids', () => {
    expect(() => parseWorkspaceFileWatchStopInput({})).toThrow('subscriptionId is required.');
  });
});
