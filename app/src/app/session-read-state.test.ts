import { expect, it } from 'vitest';
import { SessionReadState } from './session-read-state';

it('marks a session whose turn ended off screen until it is opened', () => {
  const state = new SessionReadState();
  state.observe('a', 'running');
  expect(state.observe('a', 'idle')).toBe(true);
  expect([...state.unread()]).toEqual(['a']);
  expect(state.focus('a')).toBe(true);
  expect([...state.unread()]).toEqual([]);
});

it('leaves the session on screen read', () => {
  const state = new SessionReadState();
  state.focus('a');
  state.observe('a', 'waiting');
  expect(state.observe('a', 'idle')).toBe(false);
  expect(state.unread().size).toBe(0);
});

it('does not mark sessions that were idle when first seen', () => {
  const state = new SessionReadState();
  expect(state.observe('a', 'idle')).toBe(false);
  expect(state.observe('a', 'idle')).toBe(false);
  expect(state.unread().size).toBe(0);
});
