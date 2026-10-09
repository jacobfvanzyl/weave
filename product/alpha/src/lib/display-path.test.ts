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

it('uses truncated current directories for plain shells while retaining application and custom titles', () => {
  expect(sidebarTerminalTitle('/Users/jaco/Keyphase/odin', 'zsh')).toBe('.../Keyphase/odin');
  expect(sidebarTerminalTitle('zsh', '/bin/zsh', '/Users/jaco/Keyphase/odin')).toBe('.../Keyphase/odin');
  expect(sidebarTerminalTitle('jaco@Mac:~/Keyphase/odin', '/bin/bash', '/Users/jaco/code/other')).toBe('.../code/other');
  expect(sidebarTerminalTitle('/code/project')).toBe('/code/project');
  expect(sidebarTerminalTitle('C:\\Users\\jaco\\code\\project', 'pwsh')).toBe('...\\code\\project');
  expect(sidebarTerminalTitle('nvim', 'nvim')).toBe('nvim');
  expect(sidebarTerminalTitle('Build output', 'node', '/code/project')).toBe('Build output');
  expect(sidebarTerminalTitle('Notes', 'zsh', '/code/project')).toBe('Notes');
  expect(sidebarTerminalTitle('/code/project', 'nvim', '/code/project')).toBe('nvim');
  expect(sidebarTerminalTitle('Terminal', undefined, '/Users/jaco/code/project')).toBe('.../code/project');
  expect(sidebarTerminalTitle('Terminal')).toBe('Terminal');
});
