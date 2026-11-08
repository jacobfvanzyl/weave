/// <reference types="bun" />
// A dev Dispatcher for integration tests (ADR 0030, WVE-196): the repository's debug `weave
// dispatcher run`, in a directory of its own (`WEAVE_DISPATCHER_DIR`), so it never touches the
// person's Dispatcher or this computer's pairing with it. Its WebSocket is on a free loopback port
// with `--url` set, so turning it on makes no Tailscale Serve entry and removes none. Dev Hosts
// join it over its socket, as Hosts on its computer do (`weave hosts add`), and the app's store
// pairs with it and reaches them through it, as the app does. Build the binaries first, as for
// `dev-host.ts`.
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DispatcherHost } from '../protocol';
import { websocketConnector } from '../connection';
import { type DeviceKey, webCryptoDeviceKey } from '../device-key';
import { DispatcherConnection } from '../dispatcher';
import { HostStore, type HostStoreOptions } from '../host-store';
import { memoryStorage } from '../storage';
import { type DevHost, freePort, unixConnector, until, weave } from './dev-host';

export type DevDispatcher = {
  dir: string;
  /** Its API's Unix socket, for a client on its computer. */
  socket: string;
  /** Its WebSocket, which pairing turns on: `ws://127.0.0.1:<port>`. */
  url: string;
  /** A connection on its socket, as the person on its computer: offers, devices and Hosts. */
  local(): Promise<DispatcherConnection>;
  /** A code a device pairs with once. */
  offer(name?: string): Promise<string>;
  /** Has a dev Host join over its socket as `name`, and waits until it's connected: the Host's id. */
  join(host: DevHost, name: string): Promise<string>;
  /** How it lists `hostId`, once `ready` says it's as wanted. */
  host(hostId: string, ready?: (host: DispatcherHost) => boolean): Promise<DispatcherHost>;
  /** Stops it, as the computer it runs on going away would; its devices and Hosts are kept. */
  down(): Promise<void>;
  /** Starts it again in the same directory, on the same port. */
  up(): Promise<void>;
  stop(): Promise<void>;
};

export async function startDevDispatcher(): Promise<DevDispatcher> {
  // Its sockets need a short path: macOS allows 104 bytes.
  const root = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'weave-dispatcher-'));
  const dir = join(root, 'dispatcher');
  const socket = join(dir, 'dispatcher.sock');
  const port = freePort();
  const url = `ws://127.0.0.1:${port}`;
  // Its own state directory too, so nothing here reads this computer's pairing.
  const env = { ...process.env, WEAVE_DISPATCHER_DIR: dir, XDG_STATE_HOME: join(root, 'state') };
  let running: ReturnType<typeof Bun.spawn> | undefined;
  let connection: DispatcherConnection | undefined;

  const up = async () => {
    running = Bun.spawn([weave, 'dispatcher', 'run', '--listen', `127.0.0.1:${port}`, '--url', url], { env, stdout: 'ignore', stderr: 'ignore' });
    // A socket left from before it stopped is there before it listens.
    await until(async () => existsSync(socket) && await local().then(() => true, () => false), 'the dev Dispatcher to answer');
  };
  const down = async () => {
    connection?.close();
    connection = undefined;
    running?.kill();
    await running?.exited;
    running = undefined;
  };
  const local = async () => {
    if (connection && !connection.closed) return connection;
    connection = await DispatcherConnection.connect({
      connector: unixConnector(socket),
      client: { name: 'weave-app-test', version: '0' },
      credentials: { method: 'local' },
    });
    return connection;
  };
  const host = async (hostId: string, ready: (host: DispatcherHost) => boolean = ({ connected }) => connected) => {
    let found: DispatcherHost | undefined;
    await until(async () => {
      const { hosts } = await (await local()).request('hosts/list', {});
      found = hosts.find((listed) => listed.hostId === hostId);
      return found !== undefined && ready(found);
    }, `the dev Dispatcher to list ${hostId} as wanted`);
    return found!;
  };

  try {
    await up();
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    dir,
    socket,
    url,
    local,
    async offer(name) {
      return (await (await local()).request('devices/offer', name ? { name } : {})).code;
    },
    async join(devHost, name) {
      const joining = Bun.spawn([weave, 'hosts', 'add', '--name', name, '--json'], {
        env: { ...env, WEAVE_DAEMON_DIR: devHost.dir },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (await joining.exited !== 0) throw new Error(`weave hosts add failed: ${await new Response(joining.stderr).text()}`);
      let hostId: string | undefined;
      await until(async () => {
        const { hosts } = await (await local()).request('hosts/list', {});
        hostId = hosts.find((listed) => listed.name === name && listed.connected)?.hostId;
        return hostId !== undefined;
      }, `${name} to join the dev Dispatcher`);
      return hostId!;
    },
    host,
    down,
    up,
    async stop() {
      await down();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A store as the app makes it, its keys in memory, paired with nothing yet. */
export function devStore(options: Partial<HostStoreOptions> = {}) {
  const keys = new Map<string, DeviceKey>();
  const forgotten: string[] = [];
  const storage = memoryStorage();
  const store = new HostStore({
    storage,
    keyFor: (keyId) => {
      const key = keys.get(keyId);
      return {
        publicKey: () => key ? key.publicKey() : Promise.reject(new Error('no key')),
        sign: (message) => key ? key.sign(message) : Promise.reject(new Error('no key')),
        forget: async () => {
          forgotten.push(keyId);
          keys.delete(keyId);
        },
      };
    },
    async newKey() {
      const keyId = crypto.randomUUID();
      keys.set(keyId, await webCryptoDeviceKey());
      return { keyId, key: keys.get(keyId)! };
    },
    socket: (url, subprotocol) => websocketConnector(url, subprotocol),
    client: { name: 'weave-app-test', version: '0' },
    deviceName: 'Test iPad',
    backoff: [50],
    ...options,
  });
  return { store, storage, keys, forgotten };
}
