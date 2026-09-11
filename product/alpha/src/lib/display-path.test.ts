import { expect, it } from 'vitest';
import { compactPath, compactTerminalTitle, sidebarTerminalTitle } from './display-path';

it('keeps the parent and current directory across filesystem path styles', () => {
  expect(compactPath('/Users/jaco/Documents/Keyphase/odin')).toBe('.../Keyphase/odin');
  expect(compactPath('~/Documents/Keyphase/odin/')).toBe('.../Keyphase/odin');
  expect(compactPath('C:\\Users\\jaco\\Keyphase\\odin')).toBe('...\\Keyphase\\odin');
  for (const path of ['/', '~', '~/odin', '/code/weave', 'src/index.ts', 'Terminal']) expect(compactPath(path)).toBe(path);
});
it('shortens paths inside shell titles without changing application titles or URLs', () => {
  expect(compactTerminalTitle('jaco@Mac:~/Documents/Keyphase/odin')).toBe('.../Keyphase/odin');
  expect(compactTerminalTitle('/Users/jaco/Documents/Keyphase/odin')).toBe('.../Keyphase/odin');
  for (const title of ['Terminal', 'nvim', 'https://example.com/a/b/c']) expect(compactTerminalTitle(title)).toBe(title);
});

it('removes shell identity prefixes while retaining ordinary title content', () => {
  expect(compactTerminalTitle('jaco@Mac: /Users/jaco/Documents/Keyphase/odin')).toBe('.../Keyphase/odin');
  expect(compactTerminalTitle('jaco@Mac')).toBe('Terminal');
  expect(compactTerminalTitle('nvim . — jaco@Mac')).toBe('nvim . —');
  expect(compactTerminalTitle('https://jaco@example.com/path')).toBe('https://jaco@example.com/path');
});

it('leaves directory metadata to sidebar badges while keeping process and custom titles', () => {
  expect(sidebarTerminalTitle('/Users/jaco/Keyphase/odin', 'zsh')).toBe('zsh');
  expect(sidebarTerminalTitle('jaco@Mac:~/Keyphase/odin', '/bin/bash')).toBe('bash');
  expect(sidebarTerminalTitle('/code/project')).toBe('Terminal');
  expect(sidebarTerminalTitle('C:\\Users\\jaco\\code\\project', 'pwsh')).toBe('pwsh');
  expect(sidebarTerminalTitle('nvim', 'nvim')).toBe('nvim');
  expect(sidebarTerminalTitle('Build output', 'node')).toBe('Build output');
});
