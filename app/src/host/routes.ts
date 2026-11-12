// How this device reaches the Dispatcher and the person's Hosts: the platform seam behind the
// store (ADR 0032). On the iPad, the iPhone and in a browser, the page opens the Dispatcher's
// WebSockets itself and proves the device with its key (`webRoutes`). On the Mac, the app's
// Rust core opens them and proves the device, and also reaches this Mac's own Host over its
// socket, as local clients do (ADR 0030); the page gets connections already open
// (`src/mac/routes.ts`).
import type { Connector, Credentials } from './connection';
import type { DeviceKey } from './device-key';
import { DISPATCHER, DispatcherConnection, type DispatcherNotification, type DispatcherPairing, type SocketOpener, carriedConnector } from './dispatcher';
import type { ClientInfo } from './protocol';

export type Routes = {
  /** The Dispatcher's API as the paired device, said hello to. */
  dispatcher(options: {
    pairing: DispatcherPairing;
    client: ClientInfo;
    onClosed(close: { code?: number; reason?: string }): void;
    /** What it tells the connection, as after `bots/watch`. */
    onNotification?(notification: DispatcherNotification): void;
    signal?: AbortSignal;
  }): Promise<DispatcherConnection>;
  /** Pairs with the Dispatcher at `url` with a code `weave pair` showed: its API, said hello to as the new device. */
  pair(options: {
    url: string;
    code: string;
    name: string;
    key: DeviceKey;
    client: ClientInfo;
    onClosed(close: { code?: number; reason?: string }): void;
    onNotification?(notification: DispatcherNotification): void;
  }): Promise<DispatcherConnection>;
  /** A connection the Dispatcher carries to `hostId`, said hello to with `dispatcher`. */
  host(options: { pairing: DispatcherPairing; hostId: string; client: ClientInfo }): Connector;
  /**
   * This computer's own Host, which the device reaches over its socket, with or without the
   * Dispatcher: only on the Mac.
   */
  local?: {
    /** The Host's id, if one answers on its socket. */
    find(): Promise<string | undefined>;
    /** Its socket, said hello to with `local`. */
    connector: Connector;
  };
  /**
   * Where the page opens a WebSocket for one terminal's stream on `hostId`, already carried to
   * the Host (or on this computer's own Host's terminal socket, `local`): only where the device's
   * core opens connections, the Mac. Elsewhere the terminal carries its stream itself.
   */
  terminalStream?(options: { hostId: string; local: boolean }): Promise<string>;
};

/** How a Host's connection says hello, by route. */
export const hostCredentials = (local: boolean): Credentials => local ? { method: 'local' } : { method: 'dispatcher' };

/** The page's own WebSockets to the Dispatcher at its pairing's URL, proved with the device's key. */
export const webRoutes = (socket: SocketOpener): Routes => ({
  dispatcher: ({ pairing, client, onClosed, onNotification, signal }) => DispatcherConnection.connect({
    connector: socket(pairing.url, DISPATCHER.subprotocol),
    client,
    credentials: { method: 'device', dispatcherId: pairing.dispatcherId, deviceId: pairing.deviceId, key: pairing.key },
    onClosed,
    onNotification,
    signal,
  }),
  pair: ({ url, code, name, key, client, onClosed, onNotification }) => DispatcherConnection.connect({
    connector: socket(url, DISPATCHER.subprotocol),
    client,
    credentials: { method: 'pair', code, name, key },
    onClosed,
    onNotification,
  }),
  host: ({ pairing, hostId, client }) => carriedConnector(socket, pairing, hostId, client),
});
