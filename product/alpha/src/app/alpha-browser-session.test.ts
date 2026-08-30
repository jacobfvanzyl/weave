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
      agentControlEnabled: false,
      agentAccess: 'off',
      visible: false,
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
      tabId: undefined,
      generation: undefined,
      controlRevision: undefined,
      agentControlEnabled: false,
      agentAccess: 'off',
      controlTarget: undefined,
      visible: false,
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

  it('separates observe from control and revokes access when the target Thread changes', async () => {
    const commands: AlphaBrowserCommand[] = [];
    Object.defineProperty(window, 'webkit', {
      configurable: true,
      value: { messageHandlers: { alphaBrowser: { postMessage: (command: AlphaBrowserCommand) => commands.push(command) } } },
    });
    const session = createAlphaBrowserSession();
    const unsubscribe = session.subscribe(() => undefined);
    window.dispatchEvent(new CustomEvent('weave:alpha-browser-state', { detail: {
      supported: true,
      url: 'https://fixture.test/',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      tabId: 'tab-1',
      generation: 1,
      controlRevision: 0,
    } }));
    session.setVisible(true);
    session.setControlTarget({ threadId: 'thread-1', title: 'Acceptance', controller: 'Codex' });
    session.setAgentAccess('observe');
    const request = {
      requestId: 'observe-1',
      leaseId: 'lease-1',
      address: { hostId: 'host-1', threadId: 'thread-1', clientId: 'client-1', tabId: 'tab-1' },
      generation: 1,
      expectedControlRevision: 0,
      deadlineAt: '2026-08-30T21:00:00.000Z',
      command: { kind: 'see' as const },
    };
    const observed = session.execute(request);
    expect(commands.at(-1)).toEqual({ type: 'control', request });
    window.dispatchEvent(new CustomEvent('weave:alpha-browser-control-result', { detail: {
      requestId: request.requestId,
      result: {
        requestId: request.requestId,
        leaseId: request.leaseId,
        address: request.address,
        view: {
          id: 'view-1', tabId: 'tab-1', generation: 1, controlRevision: 0,
          url: 'https://fixture.test/', loading: false,
          viewport: { width: 800, height: 600 }, text: 'Ready', elements: [], warnings: [],
        },
      },
    } }));
    await expect(observed).resolves.toMatchObject({ view: { id: 'view-1' } });
    await expect(session.execute({
      ...request,
      requestId: 'act-1',
      command: { kind: 'act', viewId: 'view-1', action: { kind: 'key', key: 'K' } },
    })).rejects.toThrow('not enabled');

    session.setControlTarget({ threadId: 'thread-2', title: 'Other', controller: 'Codex' });
    expect(session.getSnapshot()).toMatchObject({ agentAccess: 'off', agentControlEnabled: false });

    session.setAgentAccess('control');
    window.dispatchEvent(new CustomEvent('weave:alpha-browser-state', { detail: {
      supported: true,
      url: 'https://fixture.test/',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      tabId: 'tab-2',
      generation: 2,
      controlRevision: 0,
    } }));
    expect(session.getSnapshot()).toMatchObject({ agentAccess: 'off', agentControlEnabled: false });
    unsubscribe();
  });

  it('requires visible opt-in, resolves native control, and revokes on trusted human input', async () => {
    const commands: AlphaBrowserCommand[] = [];
    Object.defineProperty(window, 'webkit', {
      configurable: true,
      value: { messageHandlers: { alphaBrowser: { postMessage: (command: AlphaBrowserCommand) => commands.push(command) } } },
    });
    const session = createAlphaBrowserSession();
    const unsubscribe = session.subscribe(() => undefined);
    window.dispatchEvent(new CustomEvent('weave:alpha-browser-state', { detail: {
      supported: true,
      url: 'https://fixture.test/',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      tabId: 'tab-1',
      generation: 1,
      controlRevision: 0,
    } }));
    session.setVisible(true);
    session.setAgentControlEnabled(true);
    const request = {
      requestId: 'request-1',
      leaseId: 'lease-1',
      address: { hostId: 'host-1', threadId: 'thread-1', clientId: 'client-1', tabId: 'tab-1' },
      generation: 1,
      expectedControlRevision: 0,
      deadlineAt: '2026-08-29T21:00:00.000Z',
      command: { kind: 'see' as const },
    };
    const controlled = session.execute(request);
    expect(commands.at(-1)).toEqual({ type: 'control', request });
    window.dispatchEvent(new CustomEvent('weave:alpha-browser-control-result', { detail: {
      requestId: 'request-1',
      result: {
        requestId: 'request-1',
        leaseId: 'lease-1',
        address: request.address,
        view: {
          id: 'view-1', tabId: 'tab-1', generation: 1, controlRevision: 0,
          url: 'https://fixture.test/', loading: false,
          viewport: { width: 800, height: 600 }, text: 'Ready', elements: [], warnings: [],
        },
      },
    } }));
    await expect(controlled).resolves.toMatchObject({ view: { id: 'view-1' } });

    const failed = session.execute({ ...request, requestId: 'request-error' });
    window.dispatchEvent(new CustomEvent('weave:alpha-browser-control-result', { detail: {
      requestId: 'request-error',
      error: { code: 'STALE_VIEW', message: 'The browser view is stale.' },
    } }));
    await expect(failed).rejects.toMatchObject({ code: 'STALE_VIEW' });

    window.dispatchEvent(new CustomEvent('weave:alpha-browser-state', { detail: {
      supported: true,
      url: 'https://fixture.test/',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      tabId: 'tab-1',
      generation: 1,
      controlRevision: 1,
    } }));
    expect(session.getSnapshot().agentControlEnabled).toBe(false);
    await expect(session.execute({ ...request, requestId: 'request-2' })).rejects.toThrow('not enabled');
    unsubscribe();
  });
});
