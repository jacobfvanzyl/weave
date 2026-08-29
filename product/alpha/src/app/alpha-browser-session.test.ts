import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAlphaBrowserSession,
  type AlphaBrowserCommand,
} from './alpha-browser-session';

describe('createAlphaBrowserSession', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'webkit');
  });

  it('exposes a stable unsupported snapshot without inventing a web fallback', () => {
    const session = createAlphaBrowserSession();

    expect(session.getSnapshot()).toEqual({
      supported: false,
      url: 'https://example.com',
      loading: false,
      canGoBack: false,
      canGoForward: false,
    });
    expect(session.send({ type: 'reload' })).toBe(false);
  });

  it('drives the native handler and accepts only bounded host state', () => {
    const commands: AlphaBrowserCommand[] = [];
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
    const session = createAlphaBrowserSession();
    const changed = vi.fn();
    const unsubscribe = session.subscribe(changed);

    expect(commands).toEqual([{ type: 'status' }]);
    expect(session.send({ type: 'navigate', url: 'example.org' })).toBe(true);
    expect(commands.at(-1)).toEqual({ type: 'navigate', url: 'example.org' });

    window.dispatchEvent(new CustomEvent('weave:alpha-browser-state', {
      detail: {
        supported: true,
        url: 'https://example.org/',
        title: 'Example',
        loading: false,
        canGoBack: true,
        canGoForward: false,
        notice: 'Popup stayed in this session.',
        error: 'Recoverable fixture error.',
        policy: {
          popups: 'same-session',
          uploads: 'system-picker',
          downloads: 'unavailable',
          mediaPermissions: 'denied',
          otherPermissions: 'webkit-default',
        },
        ignored: 'not part of the interface',
      },
    }));

    expect(changed).toHaveBeenCalledOnce();
    expect(session.getSnapshot()).toEqual({
      supported: true,
      url: 'https://example.org/',
      title: 'Example',
      loading: false,
      canGoBack: true,
      canGoForward: false,
      notice: 'Popup stayed in this session.',
      error: 'Recoverable fixture error.',
      policy: {
        popups: 'same-session',
        uploads: 'system-picker',
        downloads: 'unavailable',
        mediaPermissions: 'denied',
        otherPermissions: 'webkit-default',
      },
    });

    window.dispatchEvent(new CustomEvent('weave:alpha-browser-state', {
      detail: { supported: true, url: 'missing-required-state' },
    }));
    expect(changed).toHaveBeenCalledOnce();
    expect(session.getSnapshot().url).toBe('https://example.org/');

    unsubscribe();
    window.dispatchEvent(new CustomEvent('weave:alpha-browser-state', {
      detail: {
        supported: true,
        url: 'https://ignored.example/',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    }));
    expect(session.getSnapshot().url).toBe('https://example.org/');
  });
});
