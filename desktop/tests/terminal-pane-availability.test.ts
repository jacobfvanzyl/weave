import { describe, expect, it } from 'vitest';
import { shouldCloseUnavailableTerminalPane } from '../../packages/client/src/components/app-shell/terminal-pane-availability';

describe('terminal pane availability', () => {
  it('keeps hydrated workspace terminal visibility while workspace targets are still loading', () => {
    expect(shouldCloseUnavailableTerminalPane({
      activeProduct: 'code',
      hasTerminalPaneTarget: false,
      hasWorkspaceTerminalContext: true,
      isPortalsFetched: true,
      isProjectsFetched: false,
      terminalOpen: true,
    })).toBe(false);

    expect(shouldCloseUnavailableTerminalPane({
      activeProduct: 'code',
      hasTerminalPaneTarget: false,
      hasWorkspaceTerminalContext: true,
      isPortalsFetched: false,
      isProjectsFetched: true,
      terminalOpen: true,
    })).toBe(false);
  });

  it('closes an unavailable terminal pane once workspace target loading has settled', () => {
    expect(shouldCloseUnavailableTerminalPane({
      activeProduct: 'code',
      hasTerminalPaneTarget: false,
      hasWorkspaceTerminalContext: true,
      isPortalsFetched: true,
      isProjectsFetched: true,
      terminalOpen: true,
    })).toBe(true);
  });

  it('does not close when the terminal is already hidden or has a resolved target', () => {
    expect(shouldCloseUnavailableTerminalPane({
      activeProduct: 'code',
      hasTerminalPaneTarget: true,
      hasWorkspaceTerminalContext: true,
      isPortalsFetched: true,
      isProjectsFetched: true,
      terminalOpen: true,
    })).toBe(false);

    expect(shouldCloseUnavailableTerminalPane({
      activeProduct: 'code',
      hasTerminalPaneTarget: false,
      hasWorkspaceTerminalContext: true,
      isPortalsFetched: true,
      isProjectsFetched: true,
      terminalOpen: false,
    })).toBe(false);
  });

  it('still closes terminal visibility when the active product cannot host workspace terminals', () => {
    expect(shouldCloseUnavailableTerminalPane({
      activeProduct: 'notes',
      hasTerminalPaneTarget: false,
      hasWorkspaceTerminalContext: true,
      isPortalsFetched: false,
      isProjectsFetched: false,
      terminalOpen: true,
    })).toBe(true);
  });
});
