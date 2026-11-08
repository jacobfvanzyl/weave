import { expect, it } from 'vitest';
import { ThreadReadState } from './thread-read-state';

it('marks a thread whose turn ended off screen until it is opened', () => {
  const state = new ThreadReadState();
  state.observe('a', 'running');
  expect(state.observe('a', 'idle')).toBe(true);
  expect([...state.unread()]).toEqual(['a']);
  expect(state.focus('a')).toBe(true);
  expect([...state.unread()]).toEqual([]);
});

it('leaves the thread on screen read', () => {
  const state = new ThreadReadState();
  state.focus('a');
  state.observe('a', 'waiting');
  expect(state.observe('a', 'idle')).toBe(false);
  expect(state.unread().size).toBe(0);
});

it('does not mark threads that were idle when first seen', () => {
  const state = new ThreadReadState();
  expect(state.observe('a', 'idle')).toBe(false);
  expect(state.observe('a', 'idle')).toBe(false);
  expect(state.unread().size).toBe(0);
});
