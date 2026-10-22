import { authMessage, type DeviceKey } from './device-key';
import {
  HOST_PROTOCOL,
  type AttachSessionRequest,
  type Auth,
  type ClientCapabilities,
  type ClientInfo,
  type CreateSessionRequest,
  type HelloResponse,
  type HostMethod,
  type HostNotificationMethod,
  type HostNotifications,
  type HostRequests,
  type Replay,
  type SessionState,
  type VersionRange,
} from './protocol';

/**
 * One connection's way of carrying JSON-RPC messages: the Host's WebSocket, one message per
 * text frame, or in tests its Unix socket, one per line.
 */
export type Transport = {
  send(message: string): void;
  close(): void;
};

/** What a transport tells its connection. */
export type TransportEvents = {
  message(text: string): void;
  closed(close: { code?: number; reason?: string }): void;
};

/**
 * Opens a transport; it rejects when the Host can't be reached at all, or once `signal` aborts
 * while it's still opening.
 */
export type Connector = (events: TransportEvents, signal?: AbortSignal) => Promise<Transport>;

/** An error the Host answered with, or the connection ending under a request. */
export class HostError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'HostError';
    this.code = code;
    this.data = data;
  }
}

/** JSON-RPC's own code for a method the Host doesn't have. */
const METHOD_NOT_FOUND = -32601;
/** Requests still waiting when the connection ends fail with this code. */
export const CONNECTION_CLOSED = -32099;

export type ConnectErrorKind =
  /** The Host couldn't be reached. */
  | 'connection'
  /** The Host and this app share no protocol version. */
  | 'incompatible'
  /** The Host refused `host/hello`: an unknown or revoked device, or a bad code. */
  | 'refused'
  /** The Host isn't the one this device paired with. */
  | 'wrongHost';

export class ConnectError extends Error {
  readonly kind: ConnectErrorKind;
  readonly cause?: unknown;

  constructor(kind: ConnectErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = 'ConnectError';
    this.kind = kind;
    this.cause = cause;
  }
}

/** The protocol versions this app speaks. */
export const APP_PROTOCOL: VersionRange = { min: HOST_PROTOCOL.protocol.oldestSupported, max: HOST_PROTOCOL.protocol.version };

/** How a connection proves itself at `host/hello`. */
export type Credentials =
  /** A local client: only on the Unix socket. */
  | { method: 'local' }
  /** A paired device, which signs the connection's challenge. With `hostId`, it checks first that the challenge comes from the Host it paired with. */
  | { method: 'device'; deviceId: string; key: DeviceKey; hostId?: string }
  /** A device pairing with the code `weave pair` showed. */
  | { method: 'pair'; code: string; name: string; key: DeviceKey };

/** A session `open` attached this client to. */
export type OpenedSession = {
  state: SessionState;
  /** What the replay that follows covers; none for a new session. */
  replay?: Replay;
};

export type NotificationEvent = {
  [M in HostNotificationMethod]: { type: 'notification'; method: M; params: HostNotifications[M] };
}[HostNotificationMethod];

/** Everything the Host sends, in the order it sent it. */
export type HostEvent =
  | NotificationEvent
  /** The answer to `open`, ahead of the events that follow it on the wire. */
  | { type: 'opened'; tag: number; session: OpenedSession }
  | { type: 'openFailed'; tag: number; error: HostError }
  /** The connection ended, with the WebSocket's close code when there was one. */
  | { type: 'disconnected'; code?: number; reason?: string };

export type ConnectOptions = {
  connector: Connector;
  client: ClientInfo;
  capabilities?: ClientCapabilities;
  credentials: Credentials;
  onEvent(event: HostEvent): void;
  /** Gives up on connecting: the transport closes, and `connect` rejects with the signal's reason. */
  signal?: AbortSignal;
};

type Waiting = { resolve(result: unknown): void; reject(error: HostError): void };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const describe = (error: unknown) => error instanceof Error ? error.message : error === undefined ? '' : String(error);

/**
 * One connection to a Host: hello first, then typed requests. Requests flow one way, so the
 * client needs no JSON-RPC server: everything the Host sends is an answer or a notification.
 */
export class HostConnection {
  #transport!: Transport;
  #nextId = 1;
  readonly #waiting = new Map<number, Waiting>();
  readonly #onEvent: (event: HostEvent) => void;
  #closed = false;
  #hello!: HelloResponse;

  private constructor(onEvent: (event: HostEvent) => void) {
    this.#onEvent = onEvent;
  }

  /** Connects and says hello; it rejects with a `ConnectError` saying why it couldn't. */
  static async connect(options: ConnectOptions): Promise<HostConnection> {
    const { signal } = options;
    const abandoned = () => new ConnectError('connection', describe(signal?.reason) || 'Gave up connecting to the weave Host.', signal?.reason);
    const connection = new HostConnection(options.onEvent);
    try {
      if (signal?.aborted) throw signal.reason;
      connection.#transport = await options.connector({
        message: (text) => connection.#receive(text),
        closed: (close) => connection.#ended(close),
      }, signal);
    } catch (cause) {
      if (signal?.aborted) throw abandoned();
      throw new ConnectError('connection', `Couldn't reach the weave Host: ${describe(cause)}`, cause);
    }
    const abort = () => connection.close();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) throw abandoned();
      connection.#hello = await sayHello(connection, options);
    } catch (error) {
      connection.close();
      throw signal?.aborted ? abandoned() : error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    return connection;
  }

  /** What the Host said at hello. */
  get hello(): HelloResponse {
    return this.#hello;
  }

  /** This connection, as the Host names it in turn origins and answers. */
  get clientId(): string {
    return this.#hello.clientId;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Whether the Host offers an optional part of the protocol, such as `turn/steer`. */
  supports(feature: string): boolean {
    return this.#hello.features?.includes(feature) ?? false;
  }

  /** Any request, answered when the Host answers. */
  request<M extends HostMethod>(method: M, params: HostRequests[M]['params']): Promise<HostRequests[M]['result']> {
    return new Promise((resolve, reject) => this.#send(method, params, {
      resolve: resolve as (result: unknown) => void,
      reject,
    }));
  }

  /**
   * Opens a session, new or by id. Its answer arrives as an `opened` (or `openFailed`) event with
   * `tag`, in order with the session's events, so a client knows whether to reset its transcript
   * before the replay that follows.
   */
  open(open: { create: CreateSessionRequest } | { attach: AttachSessionRequest }, tag: number) {
    const fail = (error: HostError) => this.#onEvent({ type: 'openFailed', tag, error });
    if ('create' in open) {
      this.#send('session/create', open.create, {
        resolve: (state) => this.#onEvent({ type: 'opened', tag, session: { state: state as SessionState } }),
        reject: fail,
      });
    } else {
      this.#send('session/attach', open.attach, {
        resolve: (answer) => {
          const { replay, ...state } = answer as HostRequests['session/attach']['result'];
          this.#onEvent({ type: 'opened', tag, session: { state, replay } });
        },
        reject: fail,
      });
    }
  }

  /** Ends the connection. The Host detaches it from its sessions; nothing else changes. */
  close() {
    if (this.#closed) return;
    this.#transport?.close();
    this.#ended({});
  }

  #send(method: string, params: unknown, waiting: Waiting) {
    if (this.#closed) {
      waiting.reject(new HostError(CONNECTION_CLOSED, 'The connection to the weave Host has ended.'));
      return;
    }
    const id = this.#nextId++;
    this.#waiting.set(id, waiting);
    this.#transport.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  }

  // Answers settle here, before the next message is read, so an `open`'s answer comes ahead of the
  // events that follow it.
  #receive(text: string) {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObject(message)) return;
    if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
      const waiting = this.#waiting.get(message.id);
      if (!waiting) return;
      this.#waiting.delete(message.id);
      if (isObject(message.error)) {
        const { code, message: why, data } = message.error;
        waiting.reject(new HostError(typeof code === 'number' ? code : 0, typeof why === 'string' ? why : 'The Host refused.', data));
      } else {
        waiting.resolve(message.result);
      }
      return;
    }
    // The Host sends no requests; anything with a method and no id is a notification. Clients
    // ignore ones they don't know, as a newer Host may send them.
    if (typeof message.method === 'string' && !('id' in message)) {
      this.#onEvent({ type: 'notification', method: message.method, params: message.params } as NotificationEvent);
    }
  }

  #ended(close: { code?: number; reason?: string }) {
    if (this.#closed) return;
    this.#closed = true;
    const ended = new HostError(CONNECTION_CLOSED, close.reason || 'The connection to the weave Host has ended.', close.code);
    for (const waiting of this.#waiting.values()) waiting.reject(ended);
    this.#waiting.clear();
    this.#onEvent({ type: 'disconnected', ...close });
  }
}

/** `host/hello` with `credentials`, after the challenge a paired device signs. */
async function sayHello(connection: HostConnection, options: ConnectOptions): Promise<HelloResponse> {
  const { credentials } = options;
  let auth: Auth;
  try {
    switch (credentials.method) {
      case 'local':
        auth = { method: 'local' };
        break;
      case 'pair':
        auth = { method: 'pair', code: credentials.code, device: { name: credentials.name, publicKey: await credentials.key.publicKey() } };
        break;
      case 'device': {
        const challenge = await connection.request('host/challenge', {});
        if (credentials.hostId !== undefined && challenge.hostId !== credentials.hostId) {
          throw new ConnectError('wrongHost', "This isn't the weave Host this device paired with.");
        }
        const signature = await credentials.key.sign(authMessage(challenge.hostId, credentials.deviceId, challenge.nonce));
        auth = { method: 'device', deviceId: credentials.deviceId, signature };
        break;
      }
    }
    return await connection.request('host/hello', {
      protocol: APP_PROTOCOL,
      client: options.client,
      auth,
      capabilities: options.capabilities ?? {},
    });
  } catch (error) {
    throw helloFailed(error);
  }
}

/** Why `host/hello` failed, as the person should hear it. */
function helloFailed(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (!(error instanceof HostError)) return new ConnectError('connection', describe(error), error);
  if (error.code === HOST_PROTOCOL.errors.incompatibleProtocol) return incompatible(error);
  // A Host from before this protocol answers nothing but ACP.
  if (error.code === METHOD_NOT_FOUND) {
    return new ConnectError('incompatible', 'The weave Host is older than this app; update it.', error);
  }
  if (error.code === CONNECTION_CLOSED) {
    // 4002: the Host gave up on this device's hello. Any other close is the network's.
    return error.data === HOST_PROTOCOL.websocket.closeUnauthenticated
      ? new ConnectError('refused', `The weave Host closed the connection: ${error.message}`, error)
      : new ConnectError('connection', error.message, error);
  }
  return new ConnectError('refused', error.message, error);
}

const versions = ({ min, max }: VersionRange) => min === max ? `version ${min}` : `versions ${min} to ${max}`;

/** A Host that shares no protocol version with this app needs another version of it, or of weave. */
function incompatible(error: HostError): ConnectError {
  const { data } = error;
  if (!isObject(data) || typeof data.min !== 'number' || typeof data.max !== 'number') {
    return new ConnectError('incompatible', `The weave Host and this app share no protocol version (${error.message}).`, error);
  }
  const host = { min: data.min, max: data.max };
  const speaks = `it speaks protocol ${versions(host)}; this app speaks ${versions(APP_PROTOCOL)}`;
  return new ConnectError('incompatible', host.min > APP_PROTOCOL.max
    ? `This Host needs a newer version of the app: ${speaks}.`
    : `This Host needs an older version of the app, or a newer weave on its computer: ${speaks}.`, error);
}

/**
 * The Host's WebSocket at `url` (`wss://` through Tailscale Serve), offering the protocol's
 * subprotocol. In the app this is the web view's own WebSocket, which sends the app's `Origin`.
 */
export function websocketConnector(url: string, WebSocketImpl: typeof WebSocket = WebSocket): Connector {
  return (events, signal) => new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url, HOST_PROTOCOL.websocket.subprotocol);
    let open = false;
    // One still opening, as on a network that's gone, is closed rather than waited for.
    const abort = () => {
      if (open) return;
      socket.close();
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    socket.onopen = () => {
      open = true;
      signal?.removeEventListener('abort', abort);
      resolve({
        send: (message) => socket.send(message),
        close: () => socket.close(1000),
      });
    };
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') events.message(event.data);
    };
    socket.onclose = (event) => {
      if (!open) reject(new Error(`the WebSocket closed before it opened (${event.code})`));
      else events.closed({ code: event.code, reason: event.reason });
    };
  });
}
