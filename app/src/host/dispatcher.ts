// The app's side of the Dispatcher (ADR 0030, WVE-196): pairing with it, its API on its
// WebSocket, and the connections it carries to the person's Hosts. The app pairs only with the
// Dispatcher, lists the Hosts from it (`hosts/list`), and opens each Host through it: a carried
// connection's preamble proves the device to the Dispatcher and names the Host
// (`docs/specs/wve-175-dispatcher.md`, "Devices reaching Hosts"), and from then on the
// connection is the Host's, said hello to with `auth: {method: "dispatcher"}`.
import { CONNECTION_CLOSED, ConnectError, type Connector, HostError, type Transport, type TransportEvents } from './connection';
import type { DeviceKey } from './device-key';
import {
  HOST_PROTOCOL,
  type Auth,
  type CarriedStream,
  type ClientInfo,
  type DispatcherHello,
  type DispatcherMethod,
  type DispatcherRequests,
  type HostUnavailable,
} from './protocol';

export const DISPATCHER = HOST_PROTOCOL.dispatcher;

/** What a device signs at `dispatcher/hello`, as the Dispatcher spells it. */
export const dispatcherAuthMessage = (dispatcherId: string, deviceId: string, nonce: string) =>
  DISPATCHER.authMessage
    .replace('{dispatcherId}', () => dispatcherId)
    .replace('{deviceId}', () => deviceId)
    .replace('{nonce}', () => nonce);

/** Opens a WebSocket at `url` that offers `subprotocol`: the Dispatcher's API, or a carried connection. */
export type SocketOpener = (url: string, subprotocol: string) => Connector;

/** This device's pairing with the Dispatcher, as a connection proves it. */
export type DispatcherPairing = {
  /** Its WebSocket, `wss://` through its Tailscale Serve entry. */
  url: string;
  /** Its id, which it checks is the Dispatcher answering at `url`. */
  dispatcherId: string;
  /** What the Dispatcher calls this device. */
  deviceId: string;
  key: DeviceKey;
};

/** How a connection to the Dispatcher proves itself at `dispatcher/hello`. */
export type DispatcherCredentials =
  /** A client on its own computer, on its socket, as tests are. */
  | { method: 'local' }
  /** A paired device, which signs the connection's challenge. */
  | ({ method: 'device' } & Omit<DispatcherPairing, 'url'>)
  /** A device pairing with the code `weave dispatcher pair` showed. */
  | { method: 'pair'; code: string; name: string; key: DeviceKey };

/** JSON-RPC 2.0's own code for a method the other side doesn't have. */
const METHOD_NOT_FOUND = -32601;

const describe = (error: unknown) => error instanceof Error ? error.message : error === undefined ? '' : String(error);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type Waiting = { resolve(result: unknown): void; reject(error: HostError): void };

/**
 * Requests and their answers over a transport. The Dispatcher sends no requests, so anything
 * else it sends is a notification.
 */
class Requests {
  #transport?: Transport;
  #next = 1;
  readonly #waiting = new Map<number, Waiting>();
  #closed = false;

  get closed() {
    return this.#closed;
  }

  use(transport: Transport) {
    this.#transport = transport;
  }

  request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.#closed || !this.#transport) {
        reject(new HostError(CONNECTION_CLOSED, 'The connection to the Dispatcher has ended.'));
        return;
      }
      const id = this.#next++;
      this.#waiting.set(id, { resolve, reject });
      this.#transport.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** Settles the request `text` answers; whether it answered one. */
  receive(text: string): boolean {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return false;
    }
    if (!isObject(message) || typeof message.id !== 'number' || !('result' in message || 'error' in message)) return false;
    const waiting = this.#waiting.get(message.id);
    if (!waiting) return true;
    this.#waiting.delete(message.id);
    if (isObject(message.error)) {
      const { code, message: why, data } = message.error;
      waiting.reject(new HostError(typeof code === 'number' ? code : 0, typeof why === 'string' ? why : 'The Dispatcher refused.', data));
    } else {
      waiting.resolve(message.result);
    }
    return true;
  }

  /** The connection ended: what waits fails, with the close code as the error's data. */
  end(close: { code?: number; reason?: string }) {
    if (this.#closed) return;
    this.#closed = true;
    const ended = new HostError(CONNECTION_CLOSED, close.reason || 'The connection to the Dispatcher has ended.', close.code);
    for (const waiting of this.#waiting.values()) waiting.reject(ended);
    this.#waiting.clear();
  }
}

type Ask = <M extends DispatcherMethod>(method: M, params: DispatcherRequests[M]['params']) => Promise<DispatcherRequests[M]['result']>;

/** The challenge a paired device signs, then `dispatcher/hello` with `credentials`. */
async function prove(ask: Ask, client: ClientInfo, credentials: DispatcherCredentials): Promise<DispatcherHello> {
  let auth: Auth | undefined;
  switch (credentials.method) {
    case 'local':
      break;
    case 'pair':
      auth = { method: 'pair', code: credentials.code, device: { name: credentials.name, publicKey: await credentials.key.publicKey() } };
      break;
    case 'device': {
      const challenge = await ask('dispatcher/challenge', {});
      if (challenge.dispatcherId !== credentials.dispatcherId) {
        throw new ConnectError('unpaired', 'Another Dispatcher answers at its address now. Pair this device with it again.');
      }
      const signature = await credentials.key.sign(dispatcherAuthMessage(challenge.dispatcherId, credentials.deviceId, challenge.nonce));
      auth = { method: 'device', deviceId: credentials.deviceId, signature };
      break;
    }
  }
  return ask('dispatcher/hello', { protocol: DISPATCHER.protocol, client, ...(auth ? { auth } : {}) });
}

/** Why the Dispatcher didn't take a connection, or didn't carry it, as the person should hear it. */
export function dispatcherFailed(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (!(error instanceof HostError)) return new ConnectError('connection', `Couldn't reach the Dispatcher: ${describe(error)}`, error);
  const { errors, websocket } = HOST_PROTOCOL;
  switch (error.code) {
    case errors.unauthenticated:
      return new ConnectError('unpaired', `The Dispatcher refused this device (${error.message}). Pair it again.`, error);
    case errors.incompatibleProtocol:
      return new ConnectError('incompatible', `The Dispatcher and this app share no version of its API (${error.message}). Update weave there, or this app.`, error);
    case METHOD_NOT_FOUND:
      return new ConnectError('incompatible', 'The Dispatcher is older than this app; update weave on its computer.', error);
    case errors.hostUnavailable: {
      const data = error.data as Partial<HostUnavailable> | undefined;
      return isObject(data) && typeof data.why === 'string'
        ? new ConnectError('unavailable', data.why, error, data)
        : new ConnectError('connection', `Couldn't reach the Dispatcher: ${error.message}`, error);
    }
    case CONNECTION_CLOSED:
      // 4002 and 4000: it gave up on this device, or it was revoked meanwhile. Any other close is the network's.
      return error.data === websocket.closeUnauthenticated || error.data === websocket.closeRevoked
        ? new ConnectError('unpaired', `The Dispatcher closed the connection: ${error.message}. Pair this device again.`, error)
        : new ConnectError('connection', `Couldn't reach the Dispatcher: ${error.message}`, error);
    default:
      // As for a Host that never joined it, or that it no longer has.
      return new ConnectError('unavailable', error.message, error);
  }
}

export type DispatcherConnectOptions = {
  connector: Connector;
  client: ClientInfo;
  credentials: DispatcherCredentials;
  /** The connection ended, with the WebSocket's close code when there was one. */
  onClosed?(close: { code?: number; reason?: string }): void;
  /** Gives up on connecting: the transport closes, and `connect` rejects with the signal's reason. */
  signal?: AbortSignal;
};

/** One connection to the Dispatcher's API: hello first, then typed requests, such as `hosts/list`. */
export class DispatcherConnection {
  readonly #requests = new Requests();
  #transport!: Transport;
  #hello!: DispatcherHello;
  #onClosed?: (close: { code?: number; reason?: string }) => void;

  private constructor() {}

  /** Connects and says hello; it rejects with a `ConnectError` saying why it couldn't. */
  static async connect(options: DispatcherConnectOptions): Promise<DispatcherConnection> {
    const { signal } = options;
    const abandoned = () => new ConnectError('connection', describe(signal?.reason) || 'Gave up connecting to the Dispatcher.', signal?.reason);
    const connection = new DispatcherConnection();
    const events: TransportEvents = {
      message: (text) => { connection.#requests.receive(text); },
      closed: (close) => connection.#ended(close),
    };
    try {
      if (signal?.aborted) throw signal.reason;
      connection.#transport = await options.connector(events, signal);
    } catch (cause) {
      if (signal?.aborted) throw abandoned();
      throw new ConnectError('connection', `Couldn't reach the Dispatcher: ${describe(cause)}`, cause);
    }
    connection.#requests.use(connection.#transport);
    const abort = () => connection.close();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      connection.#hello = await prove((method, params) => connection.request(method, params), options.client, options.credentials);
    } catch (error) {
      connection.close();
      throw signal?.aborted ? abandoned() : dispatcherFailed(error);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    connection.#onClosed = options.onClosed;
    return connection;
  }

  /** What the Dispatcher said at hello: its id, and the device this one is there. */
  get hello(): DispatcherHello {
    return this.#hello;
  }

  get closed(): boolean {
    return this.#requests.closed;
  }

  request<M extends DispatcherMethod>(method: M, params: DispatcherRequests[M]['params']): Promise<DispatcherRequests[M]['result']> {
    return this.#requests.request(method, params) as Promise<DispatcherRequests[M]['result']>;
  }

  /** Ends the connection. */
  close() {
    if (this.closed) return;
    this.#transport?.close();
    this.#ended({});
  }

  #ended(close: { code?: number; reason?: string }) {
    if (this.closed) return;
    this.#requests.end(close);
    this.#onClosed?.(close);
  }
}

/**
 * A connection the Dispatcher at `pairing.url` carries to `host`, by id or name: the WebSocket
 * with the carry subprotocol, on which the device proves its key and names the Host in
 * `hosts/open`. Once the Dispatcher answers, it passes everything through, and the transport is
 * the Host's. It rejects with a `ConnectError`: `unavailable` for a Host the Dispatcher can't
 * reach now, with `hosts/list`'s status and why as its data.
 */
export function carriedConnector(open: SocketOpener, pairing: DispatcherPairing, host: string, client: ClientInfo, stream: CarriedStream = 'host'): Connector {
  return async (events, signal) => {
    const preamble = new Requests();
    let carried = false;
    let transport: Transport;
    try {
      transport = await open(pairing.url, DISPATCHER.carrySubprotocol)({
        message: (text) => { if (carried) events.message(text); else preamble.receive(text); },
        closed: (close) => { if (carried) events.closed(close); else preamble.end(close); },
      }, signal);
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new ConnectError('connection', `Couldn't reach the Dispatcher: ${describe(cause)}`, cause);
    }
    preamble.use(transport);
    const abort = () => transport.close();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const ask: Ask = (method, params) => preamble.request(method, params) as never;
      await prove(ask, client, { method: 'device', dispatcherId: pairing.dispatcherId, deviceId: pairing.deviceId, key: pairing.key });
      await ask('hosts/open', { host, stream });
    } catch (error) {
      transport.close();
      throw signal?.aborted ? signal.reason : dispatcherFailed(error);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    carried = true;
    return transport;
  };
}
