// How the device's app and its Surface (WVE-183) reach each other. In the native shell the
// `Surface` plugin (`ios/App/App/Surface.swift`) relays between the app's web view and the
// Surface's; in a browser, a BroadcastChannel joins a tab at `?mock=…&idiom=phone` to one at
// `?surface`, for working on both without a display.
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { FromSurface, ToSurface } from './surface-messages';

/**
 * Whether the device has a Surface: `available` while a display is connected that one can show
 * on, `enabled` unless the person turned it off, and `connected` once its page is up and asks for
 * what to show.
 */
export type SurfaceStatus = { available: boolean; enabled: boolean; connected: boolean };

export const NO_SURFACE: SurfaceStatus = { available: false, enabled: true, connected: false };

/** The device's end. */
export type SurfaceLink = {
  status(): Promise<SurfaceStatus>;
  onStatus(listener: (status: SurfaceStatus) => void): () => void;
  onMessage(listener: (message: FromSurface) => void): () => void;
  send(message: ToSurface): void;
  /** Turns the Surface off, handing the display back to mirroring, or on again. */
  setEnabled(enabled: boolean): void;
  /** Lets the device turn to landscape, for a bigger keyboard while the thread is on the Surface. */
  setLandscape(allowed: boolean): void;
};

type SurfacePlugin = {
  status(): Promise<SurfaceStatus>;
  send(input: { message: string }): Promise<void>;
  setEnabled(input: { enabled: boolean }): Promise<void>;
  setLandscape(input: { allowed: boolean }): Promise<void>;
  addListener(event: 'status', listener: (status: SurfaceStatus) => void): Promise<PluginListenerHandle>;
  addListener(event: 'message', listener: (event: { message: string }) => void): Promise<PluginListenerHandle>;
};

const parse = <T>(text: string): T | undefined => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};

const listen = (pending: Promise<PluginListenerHandle>) => () => void pending.then((handle) => handle.remove());

function nativeLink(): SurfaceLink {
  const plugin = registerPlugin<SurfacePlugin>('Surface');
  return {
    status: () => plugin.status(),
    onStatus: (listener) => listen(plugin.addListener('status', listener)),
    onMessage: (listener) => listen(plugin.addListener('message', ({ message }) => {
      const parsed = parse<FromSurface>(message);
      if (parsed) listener(parsed);
    })),
    send: (message) => void plugin.send({ message: JSON.stringify(message) }),
    setEnabled: (enabled) => void plugin.setEnabled({ enabled }),
    setLandscape: (allowed) => void plugin.setLandscape({ allowed }),
  };
}

const CHANNEL = 'weave-surface';

type ChannelMessage = { to: 'surface'; message: ToSurface } | { to: 'device'; message: FromSurface } | { to: 'device'; gone: true };

/** A browser tab's end, with a Surface in another tab. There's no display, so it's always available. */
function channelLink(): SurfaceLink {
  const channel = new BroadcastChannel(CHANNEL);
  let status: SurfaceStatus = { available: false, enabled: true, connected: false };
  const statusListeners = new Set<(status: SurfaceStatus) => void>();
  const messageListeners = new Set<(message: FromSurface) => void>();
  const update = (next: Partial<SurfaceStatus>) => {
    status = { ...status, ...next };
    for (const listener of statusListeners) listener(status);
  };
  channel.addEventListener('message', ({ data }: MessageEvent<ChannelMessage>) => {
    if (data.to !== 'device') return;
    if ('gone' in data) {
      update({ available: false, connected: false });
      return;
    }
    if (data.message.kind === 'ready') update({ available: true, connected: status.enabled });
    for (const listener of messageListeners) listener(data.message);
  });
  return {
    status: async () => status,
    onStatus: (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onMessage: (listener) => {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    send: (message) => {
      if (status.connected) channel.postMessage({ to: 'surface', message } satisfies ChannelMessage);
    },
    setEnabled: (enabled) => update({ enabled, connected: enabled && status.available }),
    setLandscape: () => {},
  };
}

/** The device's link: the plugin in the native shell, a BroadcastChannel in a browser, or none. */
export function deviceSurfaceLink(): SurfaceLink | undefined {
  if (Capacitor.isNativePlatform()) return nativeLink();
  return typeof BroadcastChannel === 'undefined' ? undefined : channelLink();
}

/** The Surface's end. */
export type SurfaceEnd = {
  onMessage(listener: (message: ToSurface) => void): () => void;
  send(message: FromSurface): void;
};

type SurfaceWindow = Window & {
  /** The native shell delivers the device's messages here (`Surface.swift`). */
  weaveSurface?: { receive(message: string): void };
  webkit?: { messageHandlers?: { surface?: { postMessage(message: string): void } } };
};

/** The Surface's end: the native shell's message handler, or a BroadcastChannel in a browser. */
export function surfaceEnd(): SurfaceEnd {
  const win = window as SurfaceWindow;
  const listeners = new Set<(message: ToSurface) => void>();
  const deliver = (message: ToSurface) => {
    for (const listener of listeners) listener(message);
  };
  const native = win.webkit?.messageHandlers?.surface;
  if (native) {
    win.weaveSurface = {
      receive: (text) => {
        const message = parse<ToSurface>(text);
        if (message) deliver(message);
      },
    };
    return {
      onMessage: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      send: (message) => native.postMessage(JSON.stringify(message)),
    };
  }
  const channel = new BroadcastChannel(CHANNEL);
  channel.addEventListener('message', ({ data }: MessageEvent<ChannelMessage>) => {
    if (data.to === 'surface') deliver(data.message);
  });
  window.addEventListener('pagehide', () => channel.postMessage({ to: 'device', gone: true } satisfies ChannelMessage));
  return {
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: (message) => channel.postMessage({ to: 'device', message } satisfies ChannelMessage),
  };
}
