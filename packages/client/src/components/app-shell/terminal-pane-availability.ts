type ShouldCloseUnavailableTerminalPaneInput = {
  hasTerminalPaneTarget: boolean;
  hasWorkspaceTerminalContext: boolean;
  isPortalsFetched: boolean;
  isProjectsFetched: boolean;
  terminalOpen: boolean;
};

export const shouldCloseUnavailableTerminalPane = ({
  hasTerminalPaneTarget,
  hasWorkspaceTerminalContext,
  isPortalsFetched,
  isProjectsFetched,
  terminalOpen,
}: ShouldCloseUnavailableTerminalPaneInput) => {
  if (!terminalOpen || hasTerminalPaneTarget) return false;
  if (
    hasWorkspaceTerminalContext
    && (!isProjectsFetched || !isPortalsFetched)
  ) {
    return false;
  }
  return true;
};
