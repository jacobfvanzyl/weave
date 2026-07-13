import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  RpcApplicationError,
  RpcPeer,
  RpcRemoteError,
  type RpcSocket,
} from "./peer.ts";

class MemorySocket implements RpcSocket {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  peer?: RpcPeer;
  closed?: { code?: number; reason?: string };
  sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
    queueMicrotask(() => void this.peer?.receive(data));
  }

  close(code?: number, reason?: string) {
    this.readyState = WebSocket.CLOSED;
    this.closed = { code, reason };
    this.peer?.socketClosed(reason);
  }
}

const connectedPeers = () => {
  const leftSocket = new MemorySocket();
  const rightSocket = new MemorySocket();
  const left = new RpcPeer(leftSocket);
  const right = new RpcPeer(rightSocket);
  leftSocket.peer = right;
  rightSocket.peer = left;
  return { left, right, leftSocket, rightSocket };
};

Deno.test("RpcPeer correlates concurrent requests and reverse requests", async () => {
  const { left, right } = connectedPeers();
  right.register("sum", (params) => {
    const values = params as number[];
    return values.reduce((total, value) => total + value, 0);
  });
  left.register("double", (params) => Number(params) * 2);
  right.register(
    "reverse",
    async (params) => await right.request("double", params),
  );

  const [sum, reverse] = await Promise.all([
    left.request<number>("sum", [1, 2, 3]),
    left.request<number>("reverse", 9),
  ]);
  assertEquals(sum, 6);
  assertEquals(reverse, 18);
});

Deno.test("RpcPeer carries application errors", async () => {
  const { left, right } = connectedPeers();
  right.register("fail", () => {
    throw new RpcApplicationError(-32004, "Missing", { code: "NOT_FOUND" });
  });
  await assertRejects(
    () => left.request("fail"),
    RpcRemoteError,
    "Missing",
  );
});

Deno.test("RpcPeer rejects JSON-RPC batches", async () => {
  const socket = new MemorySocket();
  const peer = new RpcPeer(socket);
  await peer.receive("[]");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(socket.closed, undefined);
  assertEquals(JSON.parse(socket.sent[0]), {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message: "JSON-RPC batches are not supported." },
  });
});

Deno.test("RpcPeer reports malformed JSON without closing the connection", async () => {
  const socket = new MemorySocket();
  const peer = new RpcPeer(socket);
  await peer.receive("{");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(JSON.parse(socket.sent[0]), {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "Parse error" },
  });
  assertEquals(socket.closed, undefined);
});

Deno.test("RpcPeer cancellation aborts the matching remote handler", async () => {
  const { left, right } = connectedPeers();
  let remoteAborted = false;
  right.register(
    "wait",
    (_params, context) =>
      new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => {
          remoteAborted = true;
          reject(context.signal.reason);
        }, { once: true });
      }),
  );
  const controller = new AbortController();
  const request = left.request("wait", undefined, {
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new Error("caller cancelled"));
  await assertRejects(() => request, Error, "caller cancelled");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(remoteAborted);
});

Deno.test("RpcPeer request timeout cancels the remote handler", async () => {
  const { left, right } = connectedPeers();
  let remoteAborted = false;
  right.register(
    "wait",
    (_params, context) =>
      new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => {
          remoteAborted = true;
          reject(context.signal.reason);
        }, { once: true });
      }),
  );
  await assertRejects(
    () => left.request("wait", undefined, { timeoutMs: 5 }),
    Error,
    "timed out",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(remoteAborted);
});

Deno.test("RpcPeer close aborts handlers and rejects pending requests", async () => {
  const { left, right } = connectedPeers();
  let remoteAborted = false;
  right.register(
    "wait",
    (_params, context) =>
      new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => {
          remoteAborted = true;
          reject(context.signal.reason);
        }, { once: true });
      }),
  );
  const pending = left.request("wait");
  await new Promise((resolve) => setTimeout(resolve, 0));
  left.close(1000, "closed for test");
  await assertRejects(() => pending, Error, "closed for test");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(remoteAborted);
  assertEquals(left.stats.pendingRequestCount, 0);
  assertEquals(right.stats.activeRequestCount, 0);
});

Deno.test("RpcPeer enforces frame and queue hard limits", async () => {
  const frameSocket = new MemorySocket();
  const framePeer = new RpcPeer(frameSocket, { maxFrameBytes: 32 });
  await framePeer.receive("x".repeat(33));
  assertEquals(frameSocket.closed?.code, 4400);

  const queueSocket = new MemorySocket();
  queueSocket.bufferedAmount = 64;
  const queuePeer = new RpcPeer(queueSocket, { hardLimitBytes: 64 });
  queuePeer.notify("overload", {});
  assertEquals(queueSocket.closed?.code, 4429);
});

Deno.test("RpcPeer lets producers wait for outbound backpressure to clear", async () => {
  const socket = new MemorySocket();
  socket.bufferedAmount = 10;
  const peer = new RpcPeer(socket, {
    highWatermarkBytes: 10,
    hardLimitBytes: 20,
  });
  let writable = false;
  const pending = peer.waitForWritable().then(() => {
    writable = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  assertEquals(writable, false);
  socket.bufferedAmount = 0;
  await pending;
  assertEquals(writable, true);
});
