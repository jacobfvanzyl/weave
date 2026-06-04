import { describe, expect, it } from 'vitest';
import { isHiddenThread } from '../../server/src/mastra/routes/thread-visibility';

describe('thread visibility', () => {
  it('keeps Project internals and legacy Plane internals out of plain thread lists', () => {
    expect(isHiddenThread({ id: '__project__project-1' })).toBe(true);
    expect(isHiddenThread({ id: '__plane__plane-1' })).toBe(true);
    expect(isHiddenThread({ id: 'thread-1', metadata: { kind: 'project' } })).toBe(true);
    expect(isHiddenThread({ id: 'thread-2', metadata: { kind: 'plane' } })).toBe(true);
    expect(isHiddenThread({ id: 'thread-3', metadata: { mode: 'plain' } })).toBe(false);
  });
});
