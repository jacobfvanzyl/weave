import { describe, expect, it } from 'vitest';
import {
  getActiveTerminalPanelTab,
  getRestoredActiveTerminalTabId,
  getSortedUniqueTerminalWindows,
  getTerminalPanelTabLabel,
  getTerminalSessionRenderItems,
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
});
