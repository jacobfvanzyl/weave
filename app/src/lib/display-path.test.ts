import { expect, it } from 'vitest';
import { compactPath, directoryName } from './display-path';

it('keeps the parent and current directory across filesystem path styles', () => {
  expect(compactPath('/Users/jaco/Documents/Keyphase/odin')).toBe('.../Keyphase/odin');
  expect(compactPath('~/Documents/Keyphase/odin/')).toBe('.../Keyphase/odin');
  expect(compactPath('C:\\Users\\jaco\\Keyphase\\odin')).toBe('...\\Keyphase\\odin');
  for (const path of ['/', '~', '~/odin', '/code/weave', 'src/index.ts']) expect(compactPath(path)).toBe(path);
});

it('names a directory by its last component', () => {
  expect(directoryName('/Users/jaco/Documents/VeeZee/weave/tui')).toBe('tui');
  expect(directoryName('/Users/jaco/weave/')).toBe('weave');
  expect(directoryName('C:\\code\\weave')).toBe('weave');
  expect(directoryName('/')).toBe('/');
});
