import { describe, expect, it } from 'vitest';
import {
  getActiveTerminalPanelTab,
  getRestoredActiveTerminalTabId,
  getSortedUniqueTerminalWindows,
  getTerminalDirectoryDisplayName,
  getTerminalPanelTabLabel,
  getTerminalSessionRenderItems,
  mergeTerminalPanelTabMeta,
} from '../../packages/client/src/components/terminal/terminal-panel-tabs';

describe('terminal panel tab rendering', () => {
  const tabs = [
    { id: 'terminal-1', terminalId: 'terminal-1' },
    { id: 'terminal-2', terminalId: 'terminal-2' },
    { id: 'terminal-3', terminalId: 'terminal-3' },
  ];

  it('keeps every terminal tab renderable while selecting one active tab', () => {
    const renderItems = getTerminalSessionRenderItems(tabs, 'terminal-2');

    expect(renderItems.map(item => item.tab.id)).toEqual(['terminal-1', 'terminal-2', 'terminal-3']);
    expect(renderItems.filter(item => item.isActive).map(item => item.tab.id)).toEqual(['terminal-2']);
  });

  it('falls back to the first tab when the stored active tab is stale', () => {
    expect(getActiveTerminalPanelTab(tabs, 'missing')?.id).toBe('terminal-1');
    expect(getTerminalSessionRenderItems(tabs, 'missing').filter(item => item.isActive).map(item => item.tab.id))
      .toEqual(['terminal-1']);
  });

  it('reconstructs tabs from tmux windows in slot order without duplicate terminal ids', () => {
    const windows = getSortedUniqueTerminalWindows([
      { terminalId: 'terminal-2', slot: 2 },
      { terminalId: 'terminal-1', slot: 1 },
      { terminalId: 'terminal-1', slot: 1 },
    ]);

    expect(windows.map(window => window.terminalId)).toEqual(['terminal-1', 'terminal-2']);
  });

  it('preserves the active restored tab when tmux still has it', () => {
    expect(getRestoredActiveTerminalTabId(tabs, 'terminal-2')).toBe('terminal-2');
    expect(getRestoredActiveTerminalTabId(tabs, 'missing')).toBe('terminal-1');
  });

  it('prefers foreground process names and ignores idle shell names', () => {
    expect(getTerminalPanelTabLabel({
      id: 'terminal-1',
      label: 'Terminal 1',
      processName: 'nvim',
      title: 'jaco@host:/repo',
      cwd: '/repo',
    })).toBe('nvim');
    expect(getTerminalPanelTabLabel({
      id: 'terminal-1',
      label: 'Terminal 1',
      processName: 'zsh',
      title: 'weave-1-abc123',
      cwd: '/repo',
    })).toBe('/repo');
  });

  it('uses Starship-style paths instead of generated terminal labels for idle shells', () => {
    expect(getTerminalPanelTabLabel({
      id: 'terminal-2',
      label: 'Terminal 2',
      title: 'Terminal 2',
      cwd: '/Users/jaco/Documents/Keyphase/odin',
    })).toBe('odin');

    expect(getTerminalPanelTabLabel({
      id: 'terminal-2',
      label: 'Terminal 2',
      title: 'jaco@host:/Users/jaco/Documents/Keyphase/odin',
      cwd: '/Users/jaco/Documents/Keyphase/odin',
    })).toBe('odin');
  });

  it('formats idle shell paths like the configured Starship directory module', () => {
    expect(getTerminalDirectoryDisplayName('/Users/jaco')).toBe('~');
    expect(getTerminalDirectoryDisplayName('/Users/jaco/tmp/weave-short')).toBe('~/tmp/weave-short');
    expect(getTerminalDirectoryDisplayName('/Users/jaco/tmp/weave-starship-check/a/b/c/d/e')).toBe('b/c/d/e');
    expect(getTerminalDirectoryDisplayName('/Users/jaco/Documents/VeeZee/weave/packages/client/src')).toBe('weave/packages/client/src');
    expect(getTerminalDirectoryDisplayName('/Users/jaco/Documents/VeeZee/weave/packages/client/src/foo')).toBe('packages/client/src/foo');
  });

  it('does not clear durable tab names when session metadata is incomplete', () => {
    const tab = {
      id: 'terminal-1',
      label: 'Terminal 1',
      cwd: '/repo/workspace',
      title: 'Terminal 1',
      status: 'running',
    };

    expect(mergeTerminalPanelTabMeta(tab, {
      cwd: undefined,
      error: undefined,
      status: 'connecting',
      title: undefined,
    })).toEqual({
      ...tab,
      status: 'connecting',
    });
  });
});
