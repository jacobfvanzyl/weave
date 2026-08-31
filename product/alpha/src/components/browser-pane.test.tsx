import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlphaBrowserCommand } from '@/app/alpha-browser-session';
import { BrowserPane } from './browser-pane';

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

describe('BrowserPane', () => {
  const commands: AlphaBrowserCommand[] = [];

  beforeEach(() => {
    commands.length = 0;
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    Object.defineProperty(window, 'webkit', {
      configurable: true,
      value: {
        messageHandlers: {
          alphaBrowser: {
            postMessage: (command: AlphaBrowserCommand) => commands.push(command),
          },
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, 'webkit');
  });

  it('provides human tab and Google navigation chrome without agent controls', async () => {
    const user = userEvent.setup();
    const maximize = vi.fn();
    const close = vi.fn();
    const { unmount } = render(
      <BrowserPane
        onClose={close}
        onToggleMaximized={maximize}
      />,
    );

    expect(commands[0]).toEqual({ type: 'status' });
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(commands).toContainEqual(expect.objectContaining({ type: 'present' }));

    act(() => window.dispatchEvent(new CustomEvent('weave:alpha-browser-state', {
      detail: {
        supported: true,
        selectedTabId: 'tab-2',
        tabs: [
          {
            id: 'tab-1',
            url: 'https://example.com/',
            title: 'Example Domain',
            loading: false,
            canGoBack: true,
            canGoForward: false,
            generation: 1,
          },
          {
            id: 'tab-2',
            url: '',
            title: '',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            generation: 2,
          },
        ],
        policy: {
          popups: 'new-tab',
          uploads: 'system-picker',
          downloads: 'unavailable',
          mediaPermissions: 'denied',
          otherPermissions: 'webkit-default',
        },
      },
    })));

    expect(screen.getByRole('tab', { name: 'Example Domain' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'New tab' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: /Agent Browser/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Popup: here/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
    expect(screen.getByText('Start browsing')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'New Tab' }));
    expect(commands).toContainEqual({ type: 'tab.new' });
    await user.click(screen.getByRole('tab', { name: 'Example Domain' }));
    expect(commands).toContainEqual({ type: 'tab.select', tabId: 'tab-1' });
    await user.click(screen.getByRole('button', { name: 'Close Example Domain' }));
    expect(commands).toContainEqual({ type: 'tab.close', tabId: 'tab-1' });

    const address = screen.getByRole('textbox', { name: 'Browser address' });
    await user.clear(address);
    await user.type(address, 'alpha tabs & webkit{Enter}');
    expect(commands).toContainEqual({
      type: 'navigate',
      tabId: 'tab-2',
      url: 'https://www.google.com/search?q=alpha%20tabs%20%26%20webkit',
    });

    await user.clear(address);
    await user.type(address, 'mailto:hello@example.com{Enter}');
    expect(screen.getByRole('alertdialog', { name: 'Open outside Alpha?' })).toBeInTheDocument();
    expect(commands).toContainEqual({ type: 'hide' });
    const overlayHide = commands.map(({ type }) => type).lastIndexOf('hide');
    fireEvent(window, new Event('resize'));
    fireEvent.scroll(window);
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(commands.slice(overlayHide + 1).some(({ type }) => type === 'present')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(commands).toContainEqual({ type: 'open.external', url: 'mailto:hello@example.com' });
    expect(address).toHaveValue('');
    expect(address).not.toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Browser Options' }));
    expect(screen.getByText('Browsing data is cleared when Alpha quits')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Forward' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Maximize Browser' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Close Browser' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Reset Browser' }));
    expect(screen.getByRole('alertdialog', { name: 'Reset Browser?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset Browser' }));
    expect(commands).toContainEqual({ type: 'reset' });

    const globalDialog = document.createElement('div');
    globalDialog.setAttribute('role', 'dialog');
    globalDialog.textContent = 'Another Alpha dialog';
    Object.defineProperty(globalDialog, 'getClientRects', {
      value: () => ({ length: 1 }),
    });
    document.body.append(globalDialog);
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    const globalOverlayHide = commands.map(({ type }) => type).lastIndexOf('hide');
    fireEvent(window, new Event('resize'));
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(commands.slice(globalOverlayHide + 1).some(({ type }) => type === 'present')).toBe(false);
    globalDialog.remove();

    const expand = screen.getByRole('button', { name: 'Maximize Browser' });
    expect(expand).toHaveAttribute('aria-pressed', 'false');
    expect(expand.querySelector('[data-symbol="expand-browser"]')).toBeInTheDocument();
    await user.click(expand);
    expect(maximize).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Close Browser' }));
    expect(close).toHaveBeenCalledOnce();

    unmount();
    expect(commands.at(-1)).toEqual({ type: 'hide' });
  });

  it('reports that browser-hosted Alpha cannot substitute an iframe', () => {
    Reflect.deleteProperty(window, 'webkit');
    render(<BrowserPane />);

    expect(screen.getByText('The embedded Browser requires an Apple native Alpha host.'))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Browser Options' })).toBeDisabled();
  });

  it('maps ordinary browser keyboard shortcuts to the active human tab', () => {
    const close = vi.fn();
    render(<BrowserPane onClose={close} />);
    act(() => window.dispatchEvent(new CustomEvent('weave:alpha-browser-state', {
      detail: {
        supported: true,
        selectedTabId: 'tab-2',
        tabs: [
          { id: 'tab-1', url: 'https://one.example/', title: 'One', loading: false, canGoBack: false, canGoForward: false },
          { id: 'tab-2', url: 'https://two.example/', title: 'Two', loading: true, canGoBack: true, canGoForward: true },
        ],
      },
    })));

    fireEvent.keyDown(window, { key: 't', metaKey: true });
    fireEvent.keyDown(window, { key: 'w', metaKey: true });
    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
    fireEvent.keyDown(window, { key: '1', metaKey: true });
    fireEvent.keyDown(window, { key: '[', metaKey: true });
    fireEvent.keyDown(window, { key: ']', metaKey: true });
    fireEvent.keyDown(window, { key: 'r', metaKey: true });
    fireEvent.keyDown(window, { key: 'O', metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'l', metaKey: true });
    fireEvent.keyDown(window, { key: 'W', metaKey: true, shiftKey: true });

    expect(commands).toEqual(expect.arrayContaining([
      { type: 'tab.new' },
      { type: 'tab.close', tabId: 'tab-2' },
      { type: 'tab.select', tabId: 'tab-1' },
      { type: 'back', tabId: 'tab-2' },
      { type: 'forward', tabId: 'tab-2' },
      { type: 'reload', tabId: 'tab-2' },
      { type: 'stop', tabId: 'tab-2' },
      { type: 'open.external', url: 'https://two.example/' },
    ]));
    expect(screen.getByRole('textbox', { name: 'Browser address' })).toHaveFocus();
    expect(close).toHaveBeenCalledOnce();
  });

  it('discards an address draft when a keyboard shortcut switches tabs', async () => {
    const user = userEvent.setup();
    render(<BrowserPane />);
    act(() => window.dispatchEvent(new CustomEvent('weave:alpha-browser-state', {
      detail: {
        supported: true,
        selectedTabId: 'tab-1',
        tabs: [
          { id: 'tab-1', url: 'https://one.example/', title: 'One', loading: false, canGoBack: false, canGoForward: false },
          { id: 'tab-2', url: 'https://two.example/', title: 'Two', loading: false, canGoBack: false, canGoForward: false },
        ],
      },
    })));

    const address = screen.getByRole('textbox', { name: 'Browser address' });
    await user.clear(address);
    await user.type(address, 'draft from tab one');
    fireEvent.keyDown(window, { key: '2', metaKey: true });
    act(() => window.dispatchEvent(new CustomEvent('weave:alpha-browser-state', {
      detail: {
        supported: true,
        selectedTabId: 'tab-2',
        tabs: [
          { id: 'tab-1', url: 'https://one.example/', title: 'One', loading: false, canGoBack: false, canGoForward: false },
          { id: 'tab-2', url: 'https://two.example/', title: 'Two', loading: false, canGoBack: false, canGoForward: false },
        ],
      },
    })));

    expect(address).toHaveValue('https://two.example/');
    expect(address).not.toHaveFocus();
    fireEvent.keyDown(address, { key: 'Enter' });
    expect(commands).not.toContainEqual(expect.objectContaining({
      type: 'navigate',
      url: 'https://www.google.com/search?q=draft%20from%20tab%20one',
    }));
  });
});
