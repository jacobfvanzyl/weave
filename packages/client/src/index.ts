export { Providers } from './app/providers';
export { ClientAppWebConnectionApp, CoppermindConnectionApp, FlareConnectionApp, WeaveConnectionApp, WebConnectionApp } from './app/web-connection';
export { WeaveAppShell } from './components/app-shell/WeaveAppShell';
export { ChatPage } from './components/chat/ChatPage';
export { ConnectionApp } from './components/connection/ConnectionApp';
export { ShortcutProvider, useShortcutController } from './components/shortcuts';
export {
  configureMastraConnection,
  getAuthHeaders,
  getChatUrl,
  getMastraUrl,
} from './lib/mastra-client';
export {
  clientAppDefinitions,
  getBuildClientAppId,
  getClientAppDefinition,
  getClientAppNavigationProducts,
  getClientAppProductLabel,
  getClientAppSelectableProducts,
  getClientAppSidebarProducts,
  isProductAllowedForClientApp,
  isProductSelectableForClientApp,
  sanitizeProductForClientApp,
  type ClientAppDefinition,
  type ClientAppId,
  type ClientAppInputId,
  type LegacyClientAppId,
} from './lib/client-app';
export type {
  ConnectionAdapter,
  ConnectionInput,
  ConnectionSettings,
  ConnectionStatus,
  ConnectionTestResult,
} from './lib/connection-types';
export type {
  TerminalClientMessage,
  TerminalHostEvent,
  TerminalSessionKind,
  TerminalStartInput,
  TerminalStartResult,
  TerminalTargetInput,
  TerminalTransport,
  TerminalWindowRecord,
} from './lib/terminal-types';
export type {
  ShortcutBinding,
  ShortcutBindingProfile,
  ShortcutCommand,
  ShortcutCommandId,
  ShortcutContext,
  ShortcutHotkey,
  ShortcutPlatform,
  ShortcutRuntimeAdapter,
  ShortcutScope,
  ShortcutSequence,
  ShortcutSurface,
  TanStackHotkey,
  TanStackHotkeySequence,
} from './lib/shortcuts';
