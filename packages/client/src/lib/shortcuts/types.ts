import type { Hotkey, HotkeyCallbackContext, HotkeySequence } from '@tanstack/react-hotkeys';

export type ShortcutSurface = 'app' | 'sidebar' | 'chat' | 'plan' | 'terminal' | 'editor';

export type ShortcutCommandId =
  | 'shortcuts.open'
  | 'sidebar.toggle'
  | 'chat.focus'
  | 'chat.toggle'
  | 'thread.new'
  | 'plan.toggle'
  | 'terminal.globalToggle'
  | 'terminal.toggle'
  | 'terminal.expandToggle'
  | 'editor.toggle'
  | 'editor.expandToggle';

export type ShortcutPlatform = 'mac' | 'ios' | 'windows' | 'linux' | 'android' | 'unknown';
export type TanStackShortcutPlatform = 'mac' | 'windows' | 'linux';

export type ShortcutHotkey = Hotkey;
export type ShortcutSequence = readonly Hotkey[];

export type ShortcutBindingKind = 'hotkey' | 'sequence';
export type ShortcutScope = 'app';

export type ShortcutBinding = {
  commandId: ShortcutCommandId;
  kind: ShortcutBindingKind;
  hotkey?: ShortcutHotkey;
  sequence?: ShortcutSequence;
  allowInInputs?: boolean;
  reservedGlobal?: boolean;
  scope?: ShortcutScope;
  order?: number;
};

export type ShortcutCommand = {
  id: ShortcutCommandId;
  label: string | ((context: ShortcutContext) => string);
  surface: ShortcutSurface;
  run: (context: ShortcutContext) => void;
  isEnabled?: (context: ShortcutContext) => boolean;
  isVisible?: (context: ShortcutContext) => boolean;
};

export const resolveShortcutCommandLabel = (command: ShortcutCommand, context: ShortcutContext) =>
  typeof command.label === 'function' ? command.label(context) : command.label;

export const isShortcutCommandVisible = (command: ShortcutCommand | undefined, context: ShortcutContext) =>
  Boolean(command && (command.isVisible?.(context) ?? true));

export const isShortcutCommandEnabled = (command: ShortcutCommand | undefined, context: ShortcutContext) =>
  Boolean(command && isShortcutCommandVisible(command, context) && (command.isEnabled?.(context) ?? true));

export type NormalizedShortcutEvent = {
  key: string;
  code: string;
  shift: boolean;
  alt: boolean;
  control: boolean;
  meta: boolean;
  repeat: boolean;
  isComposing: boolean;
  target: EventTarget | null;
};

export type ShortcutContext = {
  platform: ShortcutPlatform;
  tanStackPlatform: TanStackShortcutPlatform;
  target: EventTarget | null;
  activeSurface?: ShortcutSurface;
  isTextInputTarget: boolean;
  now: number;
  hotkeyContext?: HotkeyCallbackContext;
};

export type ShortcutBindingProfile = {
  id: string;
  name: string;
  bindings: readonly ShortcutBinding[];
};

export type ShortcutRuntimeAdapter = {
  type: 'app-window' | 'desktop-global' | 'mobile-native';
};

declare module '@tanstack/hotkeys' {
  interface HotkeyMeta {
    allowInInputs?: boolean;
    commandId?: ShortcutCommandId;
    order?: number;
    scope?: ShortcutScope;
    surface?: ShortcutSurface;
  }
}

export const toMutableShortcutSequence = (sequence: ShortcutSequence): HotkeySequence => [...sequence];
