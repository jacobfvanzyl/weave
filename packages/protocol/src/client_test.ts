import { assertEquals, assertRejects } from "jsr:@std/assert";
import { RpcConnection } from "./client.ts";
import { RpcPeer, type RpcSocket } from "./peer.ts";
import { WEAVE_RPC_PROTOCOL_VERSION } from "./schema.ts";

class MemorySocket implements RpcSocket {
  readyState = 1;
  bufferedAmount = 0;
  peer?: MemorySocket;
  listeners = new Map<string, Set<(event: any) => void>>();
  send(data: string) {
    queueMicrotask(() => this.peer?.emit("message", { data }));
  }
  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.emit("close", { code, reason });
    this.peer?.emit("close", { code, reason });
  }
  addEventListener(type: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    if (type === "open") queueMicrotask(() => listener({}));
  }
  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const sockets = () => {
  const client = new MemorySocket();
  const server = new MemorySocket();
  client.peer = server;
  server.peer = client;
  return { client, server };
};

const waitForState = async (
  connection: RpcConnection,
  expected: typeof connection.state,
  timeoutMs = 250,
) => {
  const deadline = Date.now() + timeoutMs;
  while (connection.state !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assertEquals(connection.state, expected);
};

Deno.test("RpcConnection initializes and uses one peer for requests", async () => {
  const pair = sockets();
  const serverPeer = new RpcPeer(pair.server);
  pair.server.addEventListener(
    "message",
    (event) => void serverPeer.receive(event.data),
  );
  serverPeer.register("initialize", () => ({
    protocolVersion: WEAVE_RPC_PROTOCOL_VERSION,
    connectionId: "connection-1",
    role: "client",
    heartbeatIntervalMs: 20_000,
    maxFrameBytes: 1024 * 1024,
    capabilities: ["owner.get"],
    owner: { id: "owner", name: "Owner" },
  }));
  serverPeer.register(
    "owner.get",
    () => ({ owner: { id: "owner", name: "Owner" } }),
  );
  const connection = new RpcConnection({
    serverUrl: "http://localhost:4111",
    reconnect: false,
    createSocket: () => pair.client,
    initialize: {
      protocolVersion: WEAVE_RPC_PROTOCOL_VERSION,
      role: "client",
      token: "secret",
      capabilities: [],
      client: { clientAppId: "test", clientInstanceId: "test-instance" },
    },
  });
  assertEquals(await connection.request("owner.get"), {
    owner: { id: "owner", name: "Owner" },
  });
  assertEquals(connection.state, "connected");
  connection.close();
});

Deno.test("RpcConnection closes a transport whose initialize request fails", async () => {
  const pair = sockets();
  const serverPeer = new RpcPeer(pair.server);
  pair.server.addEventListener(
    "message",
    (event) => void serverPeer.receive(event.data),
  );
  serverPeer.register("initialize", () => {
    throw new Error("bad handshake");
  });
  const connection = new RpcConnection({
    serverUrl: "http://localhost:4111",
    reconnect: false,
    createSocket: () => pair.client,
    initialize: {
      protocolVersion: WEAVE_RPC_PROTOCOL_VERSION,
      role: "client",
      token: "bad",
      capabilities: [],
      client: { clientAppId: "test", clientInstanceId: "bad-instance" },
    },
  });
  await assertRejects(() => connection.request("owner.get"));
  assertEquals(pair.client.readyState, 3);
  assertEquals(connection.state, "idle");
});

Deno.test("RpcConnection closes a transport when server heartbeats stop", async () => {
  const pair = sockets();
  const serverPeer = new RpcPeer(pair.server);
  pair.server.addEventListener(
    "message",
    (event) => void serverPeer.receive(event.data),
  );
  serverPeer.register("initialize", () => ({
    protocolVersion: WEAVE_RPC_PROTOCOL_VERSION,
    connectionId: "connection-without-heartbeats",
    role: "client",
    heartbeatIntervalMs: 5,
    maxFrameBytes: 1024 * 1024,
    capabilities: [],
    owner: { id: "owner", name: "Owner" },
  }));
  const connection = new RpcConnection({
    serverUrl: "http://localhost:4111",
    reconnect: false,
    createSocket: () => pair.client,
    initialize: {
      protocolVersion: WEAVE_RPC_PROTOCOL_VERSION,
      role: "client",
      token: "secret",
      capabilities: [],
      client: { clientAppId: "test", clientInstanceId: "heartbeat-instance" },
    },
  });

  await connection.connect();
  assertEquals(connection.state, "connected");
  await waitForState(connection, "idle");
  assertEquals(pair.client.readyState, 3);
});

Deno.test("RpcConnection stays connected while server heartbeats continue", async () => {
  const pair = sockets();
  const serverPeer = new RpcPeer(pair.server);
  pair.server.addEventListener(
    "message",
    (event) => void serverPeer.receive(event.data),
  );
  serverPeer.register("initialize", () => ({
    protocolVersion: WEAVE_RPC_PROTOCOL_VERSION,
    connectionId: "connection-with-heartbeats",
    role: "client",
    heartbeatIntervalMs: 20,
    maxFrameBytes: 1024 * 1024,
    capabilities: [],
    owner: { id: "owner", name: "Owner" },
  }));
  const connection = new RpcConnection({
    serverUrl: "http://localhost:4111",
    reconnect: false,
    createSocket: () => pair.client,
    initialize: {
      protocolVersion: WEAVE_RPC_PROTOCOL_VERSION,
      role: "client",
      token: "secret",
      capabilities: [],
      client: {
        clientAppId: "test",
        clientInstanceId: "live-heartbeat-instance",
      },
    },
  });

  await connection.connect();
  const heartbeat = setInterval(
    () =>
      serverPeer.notify("connection.ping", { at: new Date().toISOString() }),
    10,
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  clearInterval(heartbeat);

  assertEquals(connection.state, "connected");
  connection.close();
});

Deno.test("RpcConnection rejects methods outside the shared protocol catalog", async () => {
  const connection = new RpcConnection({
    serverUrl: "http://localhost:4111",
    reconnect: false,
    createSocket: () => sockets().client,
    initialize: {
      protocolVersion: WEAVE_RPC_PROTOCOL_VERSION,
      role: "client",
      token: "secret",
      capabilities: [],
      client: { clientAppId: "test", clientInstanceId: "catalog-instance" },
    },
  });
  const rawRequest = connection.request.bind(connection) as (
    method: string,
  ) => Promise<unknown>;
  await assertRejects(() => rawRequest("legacy.rest.call"), Error);
});
