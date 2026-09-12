import { createContext, useContext } from 'react';
export type TerminalPaneAction = { terminate(): Promise<void>; enabled: boolean };
export const TerminalPaneActionsContext = createContext<((id: string, action?: TerminalPaneAction) => void) | undefined>(undefined);
export const useTerminalPaneActions = () => useContext(TerminalPaneActionsContext);
