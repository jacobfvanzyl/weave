import { act, render, screen } from '@testing-library/react';
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

  it('drives the native browser contract and mirrors Terminal maximize semantics', async () => {
    const user = userEvent.setup();
    const maximize = vi.fn();
    const close = vi.fn();
    const { unmount } = render(
      <BrowserPane
        controlTarget={{ threadId: 'thread-1', title: 'Acceptance', controller: 'Codex' }}
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
        url: 'https://example.com/',
        title: 'Example Domain',
        loading: false,
        canGoBack: true,
        canGoForward: false,
        notice: 'Opened popup in the current Browser session.',
        policy: {
          popups: 'same-session',
          uploads: 'system-picker',
          downloads: 'unavailable',
          mediaPermissions: 'denied',
          otherPermissions: 'webkit-default',
        },
      },
    })));

    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Opened popup in the current Browser session.',
    );
    expect(screen.getByText(
      'Popup: here · Upload: system picker · Download: off · Camera/mic: off · Other permissions: WebKit',
    )).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enable Agent Browser Observe' }));
    expect(screen.getByText('Agent observe · Codex · Acceptance (thread-1)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Take Over Browser' }));
    expect(screen.queryByText('Agent observe · Codex · Acceptance (thread-1)')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(commands).toContainEqual({ type: 'back' });

    const address = screen.getByRole('textbox', { name: 'Browser address' });
    await user.clear(address);
    await user.type(address, 'example.org{Enter}');
    expect(commands).toContainEqual({ type: 'navigate', url: 'example.org' });

    await user.click(screen.getByRole('button', { name: 'Reset Browser Session' }));
    expect(commands).toContainEqual({ type: 'reset' });

    act(() => window.dispatchEvent(new CustomEvent('weave:alpha-browser-state', {
      detail: {
        supported: true,
        url: 'https://example.org/',
        title: 'Example Organization',
        loading: true,
        canGoBack: true,
        canGoForward: false,
        error: 'The page stopped responding.',
      },
    })));
    expect(screen.getByRole('alert')).toHaveTextContent('The page stopped responding.');
    await user.click(screen.getByRole('button', { name: 'Stop Loading' }));
    expect(commands).toContainEqual({ type: 'stop' });

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
    expect(screen.getByRole('button', { name: 'Reset Browser Session' })).toBeDisabled();
  });
});
