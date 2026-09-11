import { expect, it } from 'vitest';
import { ThreadReadState } from './thread-read-state';
import type { ThreadAttention } from '@weave/product-protocol';
const observation = (state: ThreadAttention['state'], generation = 1): ThreadAttention => ({ state, generation, observedAt: new Date().toISOString() });

it('consumes a completion in the focused pane and never resurrects it on a later poll', () => {
  const read = new ThreadReadState(); read.focus('one'); read.started('one'); read.completed('one');
  read.focus('two'); read.observe('one', observation('working')); read.observe('one', observation('completed'));
  expect(read.unread('one')).toBe(false);
  read.observe('one', observation('completed')); expect(read.unread('one')).toBe(false);
});
it('keeps hidden and other-thread completions unread until focused, even after disconnection', () => {
  const read = new ThreadReadState(); read.completed('one');
  expect(read.unread('one')).toBe(true);
  read.focus('two'); read.observe('one', observation('completed')); expect(read.unread('one')).toBe(true);
  read.focus('one'); read.focus(undefined); read.observe('one', observation('unavailable'));
  read.observe('one', observation('completed')); expect(read.unread('one')).toBe(false);
});
it('tracks new turns and runtime generations independently and ignores refreshed observation timestamps', () => {
  const read = new ThreadReadState(); read.focus('one'); read.observe('one', observation('completed'));
  read.focus(undefined); read.observe('one', observation('completed')); expect(read.unread('one')).toBe(false);
  read.observe('one', observation('working')); read.observe('one', observation('completed')); expect(read.unread('one')).toBe(true);
  read.focus('one'); read.focus('two'); read.observe('one', observation('completed', 2)); expect(read.unread('one')).toBe(true);
});
