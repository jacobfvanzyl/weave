import type { ProductId } from '../../lib/products';

type ShouldCloseUnavailableTerminalPaneInput = {
  activeProduct: ProductId;
  hasTerminalPaneTarget: boolean;
  hasWorkspaceTerminalContext: boolean;
  isPortalsFetched: boolean;
  isProjectsFetched: boolean;
  terminalOpen: boolean;
};

export const shouldCloseUnavailableTerminalPane = ({
  activeProduct,
  hasTerminalPaneTarget,
  hasWorkspaceTerminalContext,
  isPortalsFetched,
  isProjectsFetched,
  terminalOpen,
}: ShouldCloseUnavailableTerminalPaneInput) => {
  if (!terminalOpen || hasTerminalPaneTarget) return false;
  if (
    activeProduct === 'code'
    && hasWorkspaceTerminalContext
    && (!isProjectsFetched || !isPortalsFetched)
  ) {
    return false;
  }
  return true;
};
