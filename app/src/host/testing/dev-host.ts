/// <reference types="bun" />
// A dev weave Host for integration tests: the repository's debug `weave`, in a directory of its own
// (`WEAVE_DAEMON_DIR`), so it never touches an installed Host, with the fake agent as `fake` and
// its WebSocket on a free loopback port. `fake-minimal` is the fake agent advertising nothing
// optional, steering included, and `fake-auth` one that needs signing in. Build the binaries first:
//
//   (cd .. && cargo build -p weave-cli -p weave-fake-agent)
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Connector } from '../connection';

const repository = resolve(import.meta.dirname, '../../../..');
const weave = join(repository, 'target/debug/weave');
const fakeAgent = join(repository, 'target/debug/weave-fake-agent');

/** Whether the debug binaries are there; the integration tests skip without them. */
export const devHostAvailable = () => existsSync(weave) && existsSync(fakeAgent);

export type DevHost = {
  /** The Unix socket local clients use. */
  socket: string;
  /** The WebSocket remote clients use, once an offer turns it on: `ws://127.0.0.1:<port>`. */
  url: string;
  /** A directory sessions can run in. */
  cwd: string;
  /**
   * Stops the Host as `weave daemon restart` does, its open sessions suspended, and starts it
   * again in the same directory, with the same config and port.
   */
  restart(): Promise<void>;
  stop(): Promise<void>;
};

const freePort = () => {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = server;
  server.stop(true);
  return port;
};

const until = async (ready: () => boolean | Promise<boolean>, what: string, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`The dev Host didn't get ${what} within ${ms} ms.`);
    await Bun.sleep(50);
  }
};

export async function startDevHost(): Promise<DevHost> {
  const root = await mkdtemp(join(tmpdir(), 'weave-host-'));
  const port = freePort();
  const url = `ws://127.0.0.1:${port}`;
  const config = join(root, 'config.toml');
  const cwd = join(root, 'work');
  await Bun.write(join(cwd, 'README.md'), 'A directory for test sessions.\n');
  await writeFile(config, [
    '[agents.fake]',
    `command = ${JSON.stringify(fakeAgent)}`,
    '',
    '[agents.fake-minimal]',
    `command = ${JSON.stringify(fakeAgent)}`,
    'env = { WEAVE_FAKE_AGENT_MINIMAL = "1" }',
    '',
    '[agents.fake-auth]',
    `command = ${JSON.stringify(fakeAgent)}`,
    `env = { WEAVE_FAKE_AGENT_REQUIRE_AUTH = "1", WEAVE_FAKE_AGENT_STATE = ${JSON.stringify(join(root, 'fake-auth.json'))} }`,
    '',
    '[remote]',
    `listen = "127.0.0.1:${port}"`,
    `url = ${JSON.stringify(url)}`,
    '',
  ].join('\n'));
  const daemon = join(root, 'daemon');
  const socket = join(daemon, 'daemon.sock');
  const spawn = () => Bun.spawn([weave, 'daemon', 'run', '--config', config], {
    env: { ...process.env, WEAVE_DAEMON_DIR: daemon, WEAVE_FAKE_AGENT_STATE: join(root, 'fake-agent.json') },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  let host = spawn();
  // SIGTERM stops it as `weave daemon stop` does; it removes its socket on the way out.
  const halt = async () => {
    host.kill();
    await host.exited;
  };
  const stop = async () => {
    await halt();
    await rm(root, { recursive: true, force: true });
  };
  // Its WebSocket listens once a pairing offer turns remote access on (ADR 0016), and again after
  // a restart while a device is paired; with `[remote] url` set, it makes no Tailscale Serve entry.
  const started = async () => {
    try {
      await until(() => existsSync(socket), 'its socket');
    } catch (error) {
      await stop();
      throw error;
    }
  };
  await started();
  const restart = async () => {
    await halt();
    host = spawn();
    await started();
  };
  return { socket, url, cwd, restart, stop };
}

/** The Host's Unix socket as a transport: one JSON-RPC message per line. */
export const unixConnector = (path: string): Connector => (events) => {
  let buffer = '';
  const decoder = new TextDecoder();
  return Bun.connect({
    unix: path,
    socket: {
      data(_socket, data) {
        buffer += decoder.decode(data, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (line.trim()) events.message(line);
        }
      },
      close() {
        events.closed({});
      },
    },
  }).then((socket) => ({
    send: (message: string) => { socket.write(`${message}\n`); },
    close: () => { socket.end(); },
  }));
};
