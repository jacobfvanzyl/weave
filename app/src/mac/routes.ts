// The Mac's side of the platform seam (ADR 0032): the app's Rust core (`../../src-tauri`) opens
// every connection and proves the device with the computer's key in the Secure Enclave, then
// relays the connection to the page over a channel. The page speaks the Host protocol and the
// Dispatcher's API on it as on any other device, and never holds the key. The pairing is the one
// the computer's CLI keeps (`weave dispatcher connect`): the Mac is one device to the Dispatcher.
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { ConnectError, type ConnectErrorKind, type Connector } from '@/host/connection';
import type { DeviceKey } from '@/host/device-key';
import { DispatcherConnection } from '@/host/dispatcher';
import type { DispatcherHello } from '@/host/protocol';
import type { Routes } from '@/host/routes';
import type { DispatcherRecord, PairingStorage } from '@/host/storage';

/** Whether the page runs in the Mac's app. */
export const onMac = () => isTauri();

/** What a relayed connection tells the page (`relay::Incoming`). */
export type Incoming =
  | { type: 'messages'; texts: string[] }
  | { type: 'closed'; code?: number; reason?: string };

/** Why the core couldn't open a connection (`core::Failure`). */
type Failure = { kind: ConnectErrorKind; message: string; data?: unknown };

const isFailure = (value: unknown): value is Failure =>
  typeof value === 'object' && value !== null && typeof (value as Failure).kind === 'string' && typeof (value as Failure).message === 'string';

/** The core's refusal as the page's `ConnectError`. */
export const failed = (error: unknown): ConnectError => isFailure(error)
  ? new ConnectError(error.kind, error.message, error, error.data)
  : new ConnectError('connection', error instanceof Error ? error.message : String(error), error);

/** How the page reaches the core; tests stand in for it. */
export type Core = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  channel(): Channel<Incoming>;
};

export const tauriCore: Core = {
  invoke: (command, args) => invoke(command, args),
  channel: () => new Channel<Incoming>(),
};

/**
 * A connection the core opens with `open`, which gives its id, relayed to the page. Messages the
 * page sends go to the core in order, those sent meanwhile together; once it closes the
 * connection, it hears nothing more of it.
 */
export const relayed = (core: Core, open: (channel: Channel<Incoming>) => Promise<number>): Connector => async (events, signal) => {
  let closed = false;
  const channel = core.channel();
  channel.onmessage = (incoming) => {
    if (closed) return;
    if (incoming.type === 'messages') {
      for (const text of incoming.texts) {
        if (closed) return;
        events.message(text);
      }
      return;
    }
    closed = true;
    events.closed({ ...(incoming.code !== undefined ? { code: incoming.code } : {}), ...(incoming.reason ? { reason: incoming.reason } : {}) });
  };
  let id: number;
  try {
    id = await open(channel);
  } catch (error) {
    closed = true;
    throw failed(error);
  }
  const close = () => {
    if (closed) return;
    closed = true;
    void core.invoke('relay_close', { id }).catch(() => {});
  };
  if (signal?.aborted) {
    close();
    throw signal.reason;
  }
  let waiting: string[] = [];
  let sending = false;
  const flush = async () => {
    sending = true;
    while (waiting.length > 0 && !closed) {
      const texts = waiting;
      waiting = [];
      // A connection the core has let go reports its end on the channel.
      await core.invoke('relay_send', { id, texts }).catch(() => {});
    }
    sending = false;
  };
  return {
    send(message) {
      if (closed) return;
      waiting.push(message);
      if (!sending) void flush();
    },
    close,
  };
};

type Opened = { id: number; hello: DispatcherHello };

/** The core's routes: this Mac's Host over its socket, everything else through the Dispatcher. */
export const macRoutes = (core: Core = tauriCore): Routes => {
  const api = (open: (channel: Channel<Incoming>) => Promise<Opened>, options: {
    client: Parameters<Routes['dispatcher']>[0]['client'];
    onClosed(close: { code?: number; reason?: string }): void;
    signal?: AbortSignal;
  }) => {
    let hello: DispatcherHello | undefined;
    return DispatcherConnection.connect({
      connector: relayed(core, async (channel) => {
        const opened = await open(channel);
        hello = opened.hello;
        return opened.id;
      }),
      client: options.client,
      credentials: {
        method: 'proven',
        hello: () => {
          if (!hello) throw new ConnectError('connection', "The app's core opened the Dispatcher's API without its hello.");
          return hello;
        },
      },
      onClosed: options.onClosed,
      signal: options.signal,
    });
  };
  return {
    dispatcher: ({ client, onClosed, signal }) => api((channel) => core.invoke('open_dispatcher', { channel }), { client, onClosed, signal }),
    pair: ({ url, code, name, client, onClosed }) => api((channel) => core.invoke('pair_dispatcher', { url, code, name, channel }), { client, onClosed }),
    host: ({ hostId }) => relayed(core, (channel) => core.invoke('open_host', { host: hostId, channel })),
    local: {
      find: async () => (await core.invoke<{ hostId: string } | null>('local_host'))?.hostId,
      connector: relayed(core, (channel) => core.invoke('open_local', { channel })),
    },
    // The core listens on a loopback port for the page's streams, and passes each through.
    terminalStream: ({ hostId, local }) => core.invoke<string>('terminal_stream', { host: local ? null : hostId }).catch((error) => {
      throw failed(error);
    }),
  };
};

/** The key's name in the record: the core keeps the computer's one key. */
export const MAC_KEY = 'computer';

/** The computer's key, which the core holds: the page has nothing to sign with, nor to delete. */
export const macKey: DeviceKey = {
  publicKey: () => Promise.reject(new Error("The Mac's key stays in its app's core.")),
  sign: () => Promise.reject(new Error("The Mac's key stays in its app's core.")),
  // Forgetting the pairing (`storage.save(undefined)`) deletes it with the record.
  forget: async () => {},
};

/** This computer's pairing, as the core reads it (`core::Pairing`). */
type Pairing = { url: string; dispatcherId: string; deviceId: string; name: string };

/** The Hosts the Dispatcher last listed, kept for when it can't be reached. */
const HOSTS = 'weave.mac.hosts';

const keptHosts = (dispatcherId: string): DispatcherRecord['hosts'] => {
  try {
    const kept = JSON.parse(localStorage.getItem(HOSTS) ?? 'null') as { dispatcherId?: unknown; hosts?: unknown } | null;
    if (kept?.dispatcherId !== dispatcherId || !Array.isArray(kept.hosts)) return undefined;
    return kept.hosts.filter((host): host is { id: string; name: string } =>
      typeof host?.id === 'string' && typeof host?.name === 'string');
  } catch {
    return undefined;
  }
};

/**
 * The pairing the core reads, which the CLI shares, with the Hosts last listed kept in the page.
 * Forgetting it forgets the CLI's too.
 */
export const macStorage = (core: Core = tauriCore): PairingStorage => ({
  async load() {
    const pairing = await core.invoke<Pairing | null>('pairing');
    if (!pairing) return undefined;
    const hosts = keptHosts(pairing.dispatcherId);
    return {
      dispatcherId: pairing.dispatcherId,
      name: pairing.name,
      url: pairing.url,
      deviceId: pairing.deviceId,
      keyId: MAC_KEY,
      ...(hosts ? { hosts } : {}),
    };
  },
  async save(record) {
    if (!record) {
      try {
        localStorage.removeItem(HOSTS);
      } catch {
        // Nothing kept.
      }
      await core.invoke('forget_pairing');
      return;
    }
    try {
      localStorage.setItem(HOSTS, JSON.stringify({ dispatcherId: record.dispatcherId, hosts: record.hosts ?? [] }));
    } catch {
      // The Hosts are listed again when the Dispatcher answers.
    }
  },
  oldHostKeys: async () => [],
  forgetOldHosts: async () => {},
});
