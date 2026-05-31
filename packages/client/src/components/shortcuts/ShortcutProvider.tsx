import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  createShortcutContext,
  defaultShortcutBindings,
  findDirectShortcutBinding,
  inactiveShortcutLeaderState,
  normalizeKeyboardEvent,
  reduceShortcutLeaderKey,
  resolveShortcutPlatform,
  shortcutLeaderChord,
  startShortcutLeader,
  type ShortcutBinding,
  type ShortcutChord,
  type ShortcutCommand,
  type ShortcutCommandId,
  type ShortcutContext as ShortcutCommandContext,
  type ShortcutLeaderState,
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

type ShortcutController = {
  openLeader: () => void;
};

const ShortcutControllerContext = createContext<ShortcutController | null>(null);

const consumeKeyboardEvent = (event: KeyboardEvent) => {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
};

const formatShortcutChord = (chord: ShortcutChord) => [
  chord.control ? 'Ctrl' : undefined,
  chord.alt ? 'Alt' : undefined,
  chord.shift ? 'Shift' : undefined,
  chord.meta ? 'Meta' : undefined,
  chord.mod ? 'Mod' : undefined,
  chord.key.length === 1 ? chord.key.toUpperCase() : chord.key,
].filter(Boolean).join('+');

const formatShortcutSequence = (sequence: readonly ShortcutChord[] | undefined) =>
  sequence?.map(formatShortcutChord).join(' ') ?? '';

const isCommandEnabled = (command: ShortcutCommand | undefined, context: ShortcutCommandContext) =>
  Boolean(command && (command.isEnabled?.(context) ?? true));

const getContextForDisplay = (platform: ShortcutPlatform): ShortcutCommandContext => ({
  platform,
  target: null,
  isTextInputTarget: false,
  now: Date.now(),
});

const shortcutBindingSortValue = (binding: ShortcutBinding) => {
  if (binding.commandId === 'sidebar.toggle') return 10;
  if (binding.commandId === 'chat.focus') return 20;
  if (binding.commandId === 'thread.new') return 30;
  if (binding.commandId === 'plan.toggle') return 40;
  if (binding.commandId === 'terminal.globalToggle') return 45;
  if (binding.commandId === 'terminal.toggle') return 50;
  if (binding.commandId === 'terminal.expandToggle') return 60;
  if (binding.commandId === 'editor.toggle') return 70;
  if (binding.commandId === 'editor.expandToggle') return 80;
  return 100;
};

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
    .filter(binding => binding.kind === 'leader' && binding.sequence)
    .sort((a, b) => shortcutBindingSortValue(a) - shortcutBindingSortValue(b))
    .map(binding => {
      const command = commandsById.get(binding.commandId);
      return {
        binding,
        command,
        enabled: isCommandEnabled(command, displayContext),
      };
    })
    .filter(row => row.command);
  const sequenceText = leaderState.sequence.map(event => event.key.toUpperCase()).join(' ');

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
        <KbdGroup>
          {formatShortcutChord(shortcutLeaderChord).split('+').map(part => (
            <Kbd key={part}>{part}</Kbd>
          ))}
        </KbdGroup>
      </div>
      <div className="max-h-[min(60dvh,24rem)] overflow-y-auto p-2">
        {rows.map(({ binding, command, enabled }) => (
          <div
            key={binding.commandId}
            className={cn(
              'flex min-h-9 items-center gap-3 rounded-md px-2 py-1.5 text-sm',
              enabled ? 'text-foreground' : 'text-muted-foreground/55',
            )}
            aria-disabled={!enabled}
          >
            <span className="min-w-0 flex-1 truncate">{command?.label}</span>
            <KbdGroup className="shrink-0">
              {formatShortcutSequence(binding.sequence).split(' ').map(part => (
                <Kbd key={part} className={enabled ? undefined : 'opacity-55'}>{part}</Kbd>
              ))}
            </KbdGroup>
          </div>
        ))}
      </div>
    </div>
  );
};

export const ShortcutProvider = ({
  bindings = defaultShortcutBindings,
  children,
  commands,
  leaderOverlayDelayMs = 750,
}: ShortcutProviderProps) => {
  const platform = useMemo(() => resolveShortcutPlatform(), []);
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
    setLeaderState(startShortcutLeader());
    scheduleLeaderOverlay();
  }, [scheduleLeaderOverlay]);

  const runShortcutCommand = useCallback((commandId: ShortcutCommandId, context: ShortcutCommandContext) => {
    const command = commandsByIdRef.current.get(commandId);
    if (!command) return false;
    if (!(command.isEnabled?.(context) ?? true)) {
      setLeaderState({ ...startShortcutLeader(), message: 'Unavailable' });
      return false;
    }

    command.run(context);
    return true;
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const normalizedEvent = normalizeKeyboardEvent(event);
      if (normalizedEvent.repeat || normalizedEvent.isComposing) return;

      const context = createShortcutContext(normalizedEvent, platform);
      const currentLeader = leaderStateRef.current;

      if (currentLeader.active) {
        const leaderResult = reduceShortcutLeaderKey({
          bindings: bindingsRef.current,
          context,
          event: normalizedEvent,
          state: currentLeader,
        });
        if (!leaderResult.consumed) {
          setLeaderState(leaderResult.state);
          return;
        }

        consumeKeyboardEvent(event);
        if (leaderResult.commandId) {
          if (runShortcutCommand(leaderResult.commandId, context)) {
            closeLeader();
          }
          return;
        }

        if (leaderResult.state.active) {
          setLeaderState(leaderResult.state);
        } else {
          closeLeader();
        }
        return;
      }

      const directBinding = findDirectShortcutBinding(bindingsRef.current, normalizedEvent, context);
      if (!directBinding) return;

      consumeKeyboardEvent(event);
      if (directBinding.commandId === 'shortcuts.open') {
        openLeader();
        return;
      }

      runShortcutCommand(directBinding.commandId, context);
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [closeLeader, openLeader, platform, runShortcutCommand]);

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

export const useShortcutController = () => {
  const controller = useContext(ShortcutControllerContext);
  if (!controller) throw new Error('useShortcutController must be used inside ShortcutProvider.');
  return controller;
};
