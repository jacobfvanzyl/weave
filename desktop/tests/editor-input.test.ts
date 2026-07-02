import { describe, expect, it } from 'vitest';
import { parseEditorWatchStopInput } from '../src/main/editor-input';

describe('editor input parsing', () => {
  it('accepts editor watch stop payloads from preload', () => {
    expect(parseEditorWatchStopInput({ subscriptionId: 'sub-1' })).toBe('sub-1');
  });

  it('accepts direct editor watch stop subscription ids', () => {
    expect(parseEditorWatchStopInput('sub-1')).toBe('sub-1');
  });

  it('rejects missing editor watch stop subscription ids', () => {
    expect(() => parseEditorWatchStopInput({})).toThrow('subscriptionId is required.');
  });
});
