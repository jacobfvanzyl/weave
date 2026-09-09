import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAlphaDockSnapshot } from '@/app/alpha-dock-layout';
import { DockRailActions } from './dock-rail-actions';

describe('DockRailActions', () => {
  afterEach(() => vi.useRealTimers());
  it('moves Terminal through the rail icon context menu and supports keyboard context-menu activation', async () => {
    const user = userEvent.setup();
    const move = vi.fn();
    render(
      <DockRailActions
        snapshot={createAlphaDockSnapshot()}
        disabled={false}
        onToggle={vi.fn()}
        onMovePanel={move}
      />,
    );
    const terminal = screen.getByRole('button', {
      name: 'Show Terminal Pane',
    });

    fireEvent.contextMenu(terminal);
    expect(screen.getByRole('menu', { name: 'Terminal dock position' }))
      .toBeInTheDocument();
    const dockBottom = screen.getByRole('menuitemradio', { name: 'Dock Bottom' });
    expect(dockBottom).toHaveAttribute('aria-checked', 'true');
    expect(dockBottom).toHaveFocus();
    fireEvent.keyDown(dockBottom, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitemradio', { name: 'Dock Right' })).toHaveFocus();
    await user.click(screen.getByRole('menuitemradio', { name: 'Dock Right' }));
    expect(move).toHaveBeenCalledWith('terminal', 'right');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(terminal).toHaveFocus();

    terminal.focus();
    fireEvent.keyDown(terminal, { key: 'F10', shiftKey: true });
    expect(screen.getByRole('menu', { name: 'Terminal dock position' }))
      .toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(terminal).toHaveFocus();
  });

  it('opens the placement menu on touch long-press without toggling Terminal', async () => {
    vi.useFakeTimers();
    const toggle = vi.fn();
    render(
      <DockRailActions
        snapshot={createAlphaDockSnapshot()}
        disabled={false}
        onToggle={toggle}
        onMovePanel={vi.fn()}
      />,
    );
    const terminal = screen.getByRole('button', { name: 'Show Terminal Pane' });

    const pointerDown = new Event('pointerdown', { bubbles: true });
    Object.defineProperty(pointerDown, 'pointerType', { value: 'touch' });
    fireEvent(terminal, pointerDown);
    await act(() => vi.advanceTimersByTimeAsync(500));
    fireEvent.pointerUp(terminal, { pointerType: 'touch' });
    fireEvent.click(terminal);

    expect(screen.getByRole('menu', { name: 'Terminal dock position' }))
      .toBeInTheDocument();
    expect(toggle).not.toHaveBeenCalled();
  });

});
