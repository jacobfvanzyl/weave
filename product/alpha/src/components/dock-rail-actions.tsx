import { useEffect, useRef, useState } from 'react';
import {
  FolderTreeIcon,
  TerminalIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  alphaDockButtons,
  type AlphaDockPanelId,
  type AlphaDockPosition,
  type AlphaDockSnapshot,
} from '@/app/alpha-dock-layout';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { RailDivider } from './rail-divider';

const label = (panelId: AlphaDockPanelId) =>
  panelId === 'terminal' ? 'Terminal' : 'Project';

export function DockRailActions({
  snapshot,
  disabled,
  onToggle,
  onMoveTerminal,
}: {
  snapshot: AlphaDockSnapshot;
  disabled: boolean;
  onToggle(panelId: AlphaDockPanelId): void;
  onMoveTerminal(position: AlphaDockPosition): void;
}) {
  const groups = alphaDockButtons(snapshot);
  const [terminalMenuOpen, setTerminalMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const terminalButtonRef = useRef<HTMLButtonElement>(null);
  const firstMenuItemRef = useRef<HTMLButtonElement>(null);
  const longPressRef = useRef<number | undefined>(undefined);
  const suppressTerminalClickRef = useRef(false);

  const closeTerminalMenu = (restoreFocus = false) => {
    setTerminalMenuOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => terminalButtonRef.current?.focus());
    }
  };

  useEffect(() => {
    if (!terminalMenuOpen) return;
    firstMenuItemRef.current?.focus();
  }, [terminalMenuOpen]);

  useEffect(() => {
    if (!terminalMenuOpen) return;
    const close = (event: Event) => {
      if (
        event instanceof KeyboardEvent && event.key !== 'Escape'
      ) return;
      if (
        event instanceof PointerEvent &&
        rootRef.current?.contains(event.target as Node)
      ) return;
      closeTerminalMenu(event instanceof KeyboardEvent);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
  }, [terminalMenuOpen]);

  useEffect(() => () => {
    if (longPressRef.current !== undefined) {
      window.clearTimeout(longPressRef.current);
    }
  }, []);

  const clearLongPress = () => {
    if (longPressRef.current === undefined) return;
    window.clearTimeout(longPressRef.current);
    longPressRef.current = undefined;
  };

  const isActive = (panelId: AlphaDockPanelId) => {
    const position = snapshot.panelPosition[panelId];
    const dock = snapshot.docks[position];
    return dock.open && dock.activePanelId === panelId;
  };

  const button = (panelId: AlphaDockPanelId) => {
    const active = isActive(panelId);
    const name = label(panelId);
    return (
      <Button
        key={panelId}
        ref={panelId === 'terminal' ? terminalButtonRef : undefined}
        type='button'
        size='icon'
        variant='ghost'
        aria-label={`${active ? 'Hide' : 'Show'} ${name} Pane`}
        aria-pressed={active}
        aria-haspopup={panelId === 'terminal' ? 'menu' : undefined}
        className={cn(
          active && 'text-primary',
        )}
        disabled={disabled}
        onClick={() => {
          if (panelId === 'terminal' && suppressTerminalClickRef.current) {
            suppressTerminalClickRef.current = false;
            return;
          }
          onToggle(panelId);
        }}
        onContextMenu={panelId === 'terminal'
          ? (event) => {
            event.preventDefault();
            setTerminalMenuOpen(true);
          }
          : undefined}
        onKeyDown={panelId === 'terminal'
          ? (event) => {
            if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
              event.preventDefault();
              setTerminalMenuOpen(true);
            }
          }
          : undefined}
        onPointerDown={panelId === 'terminal'
          ? (event) => {
            if (event.pointerType !== 'touch') return;
            clearLongPress();
            longPressRef.current = window.setTimeout(() => {
              suppressTerminalClickRef.current = true;
              setTerminalMenuOpen(true);
              longPressRef.current = undefined;
            }, 500);
          }
          : undefined}
        onPointerUp={clearLongPress}
        onPointerCancel={clearLongPress}
      >
        <HugeiconsIcon
          data-symbol={`${panelId}-pane`}
          icon={panelId === 'terminal' ? TerminalIcon : FolderTreeIcon}
          strokeWidth={2}
        />
      </Button>
    );
  };

  return (
    <div ref={rootRef} className='relative ml-auto flex items-center' data-slot='dock-rail-actions'>
      {groups.bottom.map(({ panelId }) =>
        button(panelId)
      )}
      {groups.showDivider && (
        <RailDivider slot='dock-group-divider' />
      )}
      {groups.right.map(({ panelId }) =>
        button(panelId)
      )}
      {terminalMenuOpen && (
        <div
          role='menu'
          aria-label='Terminal dock position'
          className='absolute right-1 bottom-[calc(100%+0.25rem)] z-50 min-w-36 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10'
        >
          {(['bottom', 'right'] as const).map((position) => (
            <button
              key={position}
              ref={position === 'bottom' ? firstMenuItemRef : undefined}
              type='button'
              role='menuitemradio'
              aria-checked={snapshot.panelPosition.terminal === position}
              className='flex min-h-7 w-full items-center rounded-md px-2 py-1 text-left text-xs outline-none hover:bg-accent focus:bg-accent focus:text-accent-foreground'
              onClick={() => {
                onMoveTerminal(position);
                closeTerminalMenu(true);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                event.preventDefault();
                const items = Array.from(
                  rootRef.current?.querySelectorAll<HTMLButtonElement>(
                    '[role="menuitemradio"]',
                  ) ?? [],
                );
                const current = items.indexOf(event.currentTarget);
                const offset = event.key === 'ArrowDown' ? 1 : -1;
                items[(current + offset + items.length) % items.length]?.focus();
              }}
            >
              <span aria-hidden='true' className='mr-2 w-3 text-primary'>
                {snapshot.panelPosition.terminal === position ? '✓' : ''}
              </span>
              Dock {position === 'bottom' ? 'Bottom' : 'Right'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
