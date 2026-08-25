import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AlphaController } from '@/app/alpha-controller';
import { AlphaShell } from './alpha-shell';

const controller = (): AlphaController => ({
  model: {
    platform: 'test',
    connection: {
      status: 'connected',
      hostUrl: 'ws://bazzite:4122',
      hostName: 'bazzite',
    },
    accessToken: 'test',
    searchQuery: '',
    projects: [],
    busy: false,
  },
  actions: {
    setHostUrl: vi.fn(),
    setAccessToken: vi.fn(),
    setSearchQuery: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    refresh: vi.fn(),
    createThread: vi.fn(),
    selectThread: vi.fn(),
    sendPrompt: vi.fn(),
    cancelPrompt: vi.fn(),
    respondToPermission: vi.fn(),
    respondToElicitation: vi.fn(),
    setMode: vi.fn(),
    setConfigOption: vi.fn(),
  },
});

describe('AlphaShell', () => {
  it('sizes the native shell to the visible viewport without duplicating the top safe area', () => {
    const originalViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    const events = new EventTarget();
    const viewport = {
      height: 640,
      offsetTop: 12,
      addEventListener: vi.fn(events.addEventListener.bind(events)),
      removeEventListener: vi.fn(events.removeEventListener.bind(events)),
    };
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: viewport,
    });

    const { container, unmount } = render(<AlphaShell controller={controller()} />);
    const shell = container.querySelector('[data-slot="sidebar-wrapper"]');

    expect(document.documentElement.style.getPropertyValue('--alpha-viewport-height')).toBe('640px');
    expect(document.documentElement.style.getPropertyValue('--alpha-viewport-top')).toBe('12px');
    expect(shell).toHaveClass(
      'top-[var(--alpha-viewport-top,0px)]',
      'h-[var(--alpha-viewport-height,100dvh)]',
    );
    expect(shell).not.toHaveClass(
      'pt-[env(safe-area-inset-top)]',
      'pb-[env(safe-area-inset-bottom)]',
    );

    viewport.height = 480;
    viewport.offsetTop = 4;
    events.dispatchEvent(new Event('resize'));
    expect(document.documentElement.style.getPropertyValue('--alpha-viewport-height')).toBe('480px');
    expect(document.documentElement.style.getPropertyValue('--alpha-viewport-top')).toBe('4px');

    unmount();
    expect(document.documentElement.style.getPropertyValue('--alpha-viewport-height')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--alpha-viewport-top')).toBe('');

    if (originalViewport) Object.defineProperty(window, 'visualViewport', originalViewport);
    else Reflect.deleteProperty(window, 'visualViewport');
  });
});
