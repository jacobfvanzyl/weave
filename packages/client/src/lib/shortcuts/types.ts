export type ShortcutSurface = 'app' | 'sidebar' | 'chat' | 'plan' | 'terminal' | 'editor';

export type ShortcutCommandId =
  | 'shortcuts.open'
  | 'sidebar.toggle'
  | 'chat.focus'
  | 'thread.new'
  | 'plan.toggle'
  | 'terminal.globalToggle'
  | 'terminal.toggle'
  | 'terminal.expandToggle'
  | 'editor.toggle'
  | 'editor.expandToggle';

export type ShortcutPlatform = 'mac' | 'ios' | 'windows' | 'linux' | 'android' | 'unknown';

export type ShortcutChord = {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  control?: boolean;
  meta?: boolean;
};

export type ShortcutSequence = readonly ShortcutChord[];

export type ShortcutBindingKind = 'direct' | 'leader';

export type ShortcutBinding = {
  commandId: ShortcutCommandId;
  kind: ShortcutBindingKind;
  chord?: ShortcutChord;
  sequence?: ShortcutSequence;
  reservedGlobal?: boolean;
};

export type ShortcutCommand = {
  id: ShortcutCommandId;
  label: string;
  surface: ShortcutSurface;
  run: (context: ShortcutContext) => void;
  isEnabled?: (context: ShortcutContext) => boolean;
};

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
  target: EventTarget | null;
  activeSurface?: ShortcutSurface;
  isTextInputTarget: boolean;
  now: number;
};

export type LeaderShortcutMatch =
  | { type: 'exact'; binding: ShortcutBinding }
  | { type: 'partial' }
  | { type: 'none' };

export type ShortcutRuntimeAdapter = {
  type: 'app-window' | 'desktop-global' | 'mobile-native';
};

export type ShortcutBindingProfile = {
  id: string;
  name: string;
  bindings: readonly ShortcutBinding[];
};
