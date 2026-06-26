import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  HotkeysProvider as TanStackHotkeysProvider,
  useHotkeys,
  useHotkeySequences,
  type HotkeysProviderOptions,
  type UseHotkeyDefinition,
  type UseHotkeySequenceDefinition,
} from '@tanstack/react-hotkeys';
import {
  createShortcutContext,
  defaultShortcutBindings,
  defaultShortcutSequenceTimeoutMs,
  findHotkeyShortcutBinding,
  findSequenceTailShortcutBinding,
  formatShortcutForDisplayParts,
  isModifierOnlyShortcutKey,
  isShortcutAllowedForTarget,
  normalizeKeyboardEvent,
  resolveShortcutPlatform,
  shortcutLeaderHotkey,
  toMutableShortcutSequence,
  toTanStackShortcutPlatform,
  type ShortcutBinding,
  type ShortcutCommand,
  type ShortcutCommandId,
  type ShortcutContext as ShortcutCommandContext,
  type ShortcutHotkey,
  type ShortcutPlatform,
} from '../../lib/shortcuts';
import { cn } from '../../lib/cn';
import { Kbd, KbdGroup } from '../ui/kbd';

type ShortcutProviderProps = {
  bindings?: readonly ShortcutBinding[];
  children: ReactNode;
  commands: readonly ShortcutCommand[];
  leaderOverlayDelayMs?: number;
};

type ShortcutRuntimeProps = Omit<ShortcutProviderProps, 'bindings' | 'leaderOverlayDelayMs'> & {
  bindings: readonly ShortcutBinding[];
  leaderOverlayDelayMs: number;
  platform: ShortcutPlatform;
};

type ShortcutController = {
  openLeader: () => void;
};

type ShortcutLeaderState = {
  active: boolean;
  message?: string;
  sequence: ShortcutHotkey[];
};

const inactiveShortcutLeaderState: ShortcutLeaderState = { active: false, sequence: [] };
const ShortcutControllerContext = createContext<ShortcutController | null>(null);

const consumeKeyboardEvent = (event: KeyboardEvent) => {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
};

const isCommandEnabled = (command: ShortcutCommand | undefined, context: ShortcutCommandContext) =>
  Boolean(command && (command.isEnabled?.(context) ?? true));

const getContextForDisplay = (platform: ShortcutPlatform): ShortcutCommandContext => ({
  platform,
  tanStackPlatform: toTanStackShortcutPlatform(platform),
  target: null,
  isTextInputTarget: false,
  now: Date.now(),
});

const shortcutBindingSortValue = (binding: ShortcutBinding) => binding.order ?? 100;

const getBindingDisplayHotkeys = (binding: ShortcutBinding) => {
  if (binding.kind === 'sequence' && binding.sequence) {
    return binding.sequence[0] === shortcutLeaderHotkey ? binding.sequence.slice(1) : binding.sequence;
  }
  return binding.hotkey ? [binding.hotkey] : [];
};

const ShortcutKbdGroup = ({
  hotkeys,
  isDisabled,
  platform,
}: {
  hotkeys: readonly ShortcutHotkey[];
  isDisabled?: boolean;
  platform: ShortcutPlatform;
}) => (
  <KbdGroup className="shrink-0">
    {hotkeys.map((hotkey, hotkeyIndex) => (
      <span key={`${hotkey}-${hotkeyIndex}`} className="inline-flex items-center gap-1">
        {hotkeyIndex > 0 ? <span className="px-0.5 text-muted-foreground/60">then</span> : null}
        {formatShortcutForDisplayParts(hotkey, platform).map(part => (
          <Kbd key={`${hotkey}-${part}`} className={isDisabled ? 'opacity-55' : undefined}>{part}</Kbd>
        ))}
      </span>
    ))}
  </KbdGroup>
);

const ShortcutOverlay = ({
  bindings,
  commandsById,
  isVisible,
  leaderState,
  platform,
}: {
  bindings: readonly ShortcutBinding[];
  commandsById: Map<ShortcutCommandId, ShortcutCommand>;
  isVisible: boolean;
  leaderState: ShortcutLeaderState;
  platform: ShortcutPlatform;
}) => {
  if (!leaderState.active || !isVisible) return null;

  const displayContext = getContextForDisplay(platform);
  const rows = bindings
    .filter(binding => binding.kind === 'sequence' && binding.sequence)
    .sort((a, b) => shortcutBindingSortValue(a) - shortcutBindingSortValue(b))
    .map(binding => {
      const command = commandsById.get(binding.commandId);
      return {
        binding,
        command,
        displayHotkeys: getBindingDisplayHotkeys(binding),
        enabled: isCommandEnabled(command, displayContext),
      };
    })
    .filter(row => row.command);
  const sequenceText = leaderState.sequence
    .map(hotkey => formatShortcutForDisplayParts(hotkey, platform).join('+'))
    .join(' ');

  return (
    <div
      className="pointer-events-none fixed left-1/2 top-16 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-border bg-popover/95 text-popover-foreground shadow-xl backdrop-blur"
      data-weave-shortcut-overlay
      role="dialog"
      aria-label="Shortcuts"
    >
      <div className="flex min-w-0 items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">Shortcuts</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {leaderState.message ?? (sequenceText ? `Sequence ${sequenceText}` : 'Choose a command')}
          </div>
        </div>
        <ShortcutKbdGroup hotkeys={[shortcutLeaderHotkey]} platform={platform} />
      </div>
      <div className="max-h-[min(60dvh,24rem)] overflow-y-auto p-2">
        {rows.map(({ binding, command, displayHotkeys, enabled }) => (
          <div
            key={binding.commandId}
            className={cn(
              'flex min-h-9 items-center gap-3 rounded-md px-2 py-1.5 text-sm',
              enabled ? 'text-foreground' : 'text-muted-foreground/55',
            )}
            aria-disabled={!enabled}
          >
            <span className="min-w-0 flex-1 truncate">{command?.label}</span>
            <ShortcutKbdGroup hotkeys={displayHotkeys} isDisabled={!enabled} platform={platform} />
          </div>
        ))}
      </div>
    </div>
  );
};

const shortcutBindingMeta = (binding: ShortcutBinding, command: ShortcutCommand | undefined) => ({
  allowInInputs: binding.allowInInputs,
  commandId: binding.commandId,
  description: command?.label,
  name: command?.label,
  order: binding.order,
  scope: binding.scope ?? 'app',
  surface: command?.surface,
});

const ShortcutRuntime = ({
  bindings,
  children,
  commands,
  leaderOverlayDelayMs,
  platform,
}: ShortcutRuntimeProps) => {
  const tanStackPlatform = toTanStackShortcutPlatform(platform);
  const commandsById = useMemo(() => new Map(commands.map(command => [command.id, command])), [commands]);
  const [leaderState, setLeaderState] = useState<ShortcutLeaderState>(inactiveShortcutLeaderState);
  const [isLeaderOverlayVisible, setIsLeaderOverlayVisible] = useState(false);
  const leaderStateRef = useRef(leaderState);
  const leaderOverlayDelayTimerRef = useRef<number | undefined>(undefined);
  const commandsByIdRef = useRef(commandsById);
  const bindingsRef = useRef(bindings);

  useEffect(() => {
    leaderStateRef.current = leaderState;
  }, [leaderState]);

  useEffect(() => {
    commandsByIdRef.current = commandsById;
  }, [commandsById]);

  useEffect(() => {
    bindingsRef.current = bindings;
  }, [bindings]);

  const clearLeaderOverlayDelay = useCallback(() => {
    if (leaderOverlayDelayTimerRef.current === undefined) return;
    window.clearTimeout(leaderOverlayDelayTimerRef.current);
    leaderOverlayDelayTimerRef.current = undefined;
  }, []);

  const hideLeaderOverlay = useCallback(() => {
    clearLeaderOverlayDelay();
    setIsLeaderOverlayVisible(false);
  }, [clearLeaderOverlayDelay]);

  const showLeaderOverlay = useCallback(() => {
    clearLeaderOverlayDelay();
    setIsLeaderOverlayVisible(true);
  }, [clearLeaderOverlayDelay]);

  const scheduleLeaderOverlay = useCallback(() => {
    clearLeaderOverlayDelay();
    setIsLeaderOverlayVisible(false);

    if (leaderOverlayDelayMs <= 0) {
      setIsLeaderOverlayVisible(true);
      return;
    }

    leaderOverlayDelayTimerRef.current = window.setTimeout(() => {
      leaderOverlayDelayTimerRef.current = undefined;
      setIsLeaderOverlayVisible(true);
    }, leaderOverlayDelayMs);
  }, [clearLeaderOverlayDelay, leaderOverlayDelayMs]);

  const closeLeader = useCallback(() => {
    hideLeaderOverlay();
    setLeaderState(inactiveShortcutLeaderState);
  }, [hideLeaderOverlay]);

  useEffect(() => () => clearLeaderOverlayDelay(), [clearLeaderOverlayDelay]);

  const openLeader = useCallback(() => {
    setLeaderState({ active: true, sequence: [] });
    scheduleLeaderOverlay();
  }, [scheduleLeaderOverlay]);

  const runShortcutCommand = useCallback((commandId: ShortcutCommandId, context: ShortcutCommandContext) => {
    const command = commandsByIdRef.current.get(commandId);
    if (!command) return false;
    if (!(command.isEnabled?.(context) ?? true)) {
      setLeaderState({ active: true, message: 'Unavailable', sequence: [] });
      showLeaderOverlay();
      return false;
    }

    command.run(context);
    return true;
  }, [showLeaderOverlay]);

  const hotkeyDefinitions = useMemo<UseHotkeyDefinition[]>(() => bindings
    .filter((binding): binding is ShortcutBinding & { hotkey: ShortcutHotkey } => binding.kind === 'hotkey' && Boolean(binding.hotkey))
    .map(binding => {
      const command = commandsById.get(binding.commandId);
      return {
        hotkey: binding.hotkey,
        callback: (event, hotkeyContext) => {
          const context = {
            ...createShortcutContext(event, platform),
            hotkeyContext,
          };
          if (!isShortcutAllowedForTarget(binding, context)) return;
          if (binding.commandId === 'shortcuts.open') {
            openLeader();
            return;
          }
          runShortcutCommand(binding.commandId, context);
        },
        options: {
          conflictBehavior: 'allow',
          ignoreInputs: binding.allowInInputs !== true,
          meta: shortcutBindingMeta(binding, command),
          platform: tanStackPlatform,
          preventDefault: true,
          stopPropagation: true,
        },
      };
    }), [bindings, commandsById, openLeader, platform, runShortcutCommand, tanStackPlatform]);

  const sequenceDefinitions = useMemo<UseHotkeySequenceDefinition[]>(() => bindings
    .filter((binding): binding is ShortcutBinding & { sequence: readonly ShortcutHotkey[] } => binding.kind === 'sequence' && Boolean(binding.sequence?.length))
    .map(binding => {
      const command = commandsById.get(binding.commandId);
      return {
        sequence: toMutableShortcutSequence(binding.sequence),
        callback: (event, hotkeyContext) => {
          const context = {
            ...createShortcutContext(event, platform),
            hotkeyContext,
          };
          if (!isShortcutAllowedForTarget(binding, context)) return;
          if (runShortcutCommand(binding.commandId, context)) {
            closeLeader();
          }
        },
        options: {
          conflictBehavior: 'allow',
          ignoreInputs: binding.allowInInputs !== true,
          meta: shortcutBindingMeta(binding, command),
          platform: tanStackPlatform,
          preventDefault: true,
          stopPropagation: true,
          timeout: defaultShortcutSequenceTimeoutMs,
        },
      };
    }), [bindings, closeLeader, commandsById, platform, runShortcutCommand, tanStackPlatform]);

  useHotkeys(hotkeyDefinitions);
  useHotkeySequences(sequenceDefinitions);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const normalizedEvent = normalizeKeyboardEvent(event);
      if (normalizedEvent.repeat || normalizedEvent.isComposing) return;

      const context = createShortcutContext(event, platform);
      const currentLeader = leaderStateRef.current;

      if (!currentLeader.active) {
        if (!context.isTextInputTarget) return;
        const directBinding = findHotkeyShortcutBinding(bindingsRef.current, event, context);
        if (!directBinding) return;

        consumeKeyboardEvent(event);
        if (directBinding.commandId === 'shortcuts.open') {
          openLeader();
          return;
        }
        runShortcutCommand(directBinding.commandId, context);
        return;
      }

      if (isModifierOnlyShortcutKey(normalizedEvent)) return;
      if (normalizedEvent.key === 'escape') {
        consumeKeyboardEvent(event);
        closeLeader();
        return;
      }

      const sequenceBinding = findSequenceTailShortcutBinding(bindingsRef.current, shortcutLeaderHotkey, event, context);
      if (sequenceBinding) {
        if (!context.isTextInputTarget) return;
        consumeKeyboardEvent(event);
        if (runShortcutCommand(sequenceBinding.commandId, context)) {
          closeLeader();
        }
        return;
      }

      consumeKeyboardEvent(event);
      setLeaderState({ active: true, message: 'No command', sequence: [] });
      showLeaderOverlay();
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [closeLeader, openLeader, platform, runShortcutCommand, showLeaderOverlay]);

  const controller = useMemo<ShortcutController>(() => ({ openLeader }), [openLeader]);

  return (
    <ShortcutControllerContext.Provider value={controller}>
      {children}
      <ShortcutOverlay
        bindings={bindings}
        commandsById={commandsById}
        isVisible={isLeaderOverlayVisible}
        leaderState={leaderState}
        platform={platform}
      />
    </ShortcutControllerContext.Provider>
  );
};

export const ShortcutProvider = ({
  bindings = defaultShortcutBindings,
  children,
  commands,
  leaderOverlayDelayMs = 750,
}: ShortcutProviderProps) => {
  const platform = useMemo(() => resolveShortcutPlatform(), []);
  const tanStackPlatform = toTanStackShortcutPlatform(platform);
  const defaultOptions = useMemo<HotkeysProviderOptions>(() => ({
    hotkey: {
      conflictBehavior: 'allow',
      ignoreInputs: true,
      platform: tanStackPlatform,
      preventDefault: true,
      stopPropagation: true,
    },
    hotkeyRecorder: {
      ignoreInputs: true,
      platform: tanStackPlatform,
    },
    hotkeySequence: {
      conflictBehavior: 'allow',
      ignoreInputs: true,
      platform: tanStackPlatform,
      preventDefault: true,
      stopPropagation: true,
      timeout: defaultShortcutSequenceTimeoutMs,
    },
    hotkeySequenceRecorder: {
      ignoreInputs: true,
      platform: tanStackPlatform,
    },
  }), [tanStackPlatform]);

  return (
    <TanStackHotkeysProvider defaultOptions={defaultOptions}>
      <ShortcutRuntime
        bindings={bindings}
        commands={commands}
        leaderOverlayDelayMs={leaderOverlayDelayMs}
        platform={platform}
      >
        {children}
      </ShortcutRuntime>
    </TanStackHotkeysProvider>
  );
};

export const useShortcutController = () => {
  const controller = useContext(ShortcutControllerContext);
  if (!controller) throw new Error('useShortcutController must be used inside ShortcutProvider.');
  return controller;
};
