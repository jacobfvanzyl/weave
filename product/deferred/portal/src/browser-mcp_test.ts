import { assert, assertEquals } from 'jsr:@std/assert@1.0.18';
import type { BrowserControlInvokeParams } from '@weave/product-protocol';
import { BrowserControlBroker } from './browser-control.ts';
import { browserMcpSocketPath, BrowserMcpBridge, runBrowserMcp } from './browser-mcp.ts';

const collect = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const next = await reader.read();
    if (next.done) return text;
    text += decoder.decode(next.value, { stream: true });
  }
};

const browserToken = (descriptor: ReturnType<BrowserMcpBridge['servers']>[number]) =>
  Object.fromEntries(descriptor.env.map(({ name, value }) => [name, value])).WEAVE_BROWSER_MCP_TOKEN!;

const handshake = async (path: string, threadId: string, token: string) => {
  const connection = await Deno.connect({ transport: 'unix', path });
  await connection.write(new TextEncoder().encode(`${JSON.stringify({
    protocol: 'weave-browser-mcp/1',
    threadId,
    token,
  })}\n`));
  const buffer = new Uint8Array(4096);
  const count = await connection.read(buffer);
  connection.close();
  return JSON.parse(new TextDecoder().decode(buffer.subarray(0, count ?? 0)).trim());
};

Deno.test('Thread-scoped MCP rotates and expires bearer tokens', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-browser-mcp-token-' });
  let now = new Date('2026-08-30T00:00:00.000Z');
  const bridge = new BrowserMcpBridge(root, new BrowserControlBroker('host-1'), () => now, 1_000);
  const first = bridge.servers('thread-1')[0]!;
  const firstToken = browserToken(first);
  const secondToken = browserToken(bridge.servers('thread-1')[0]!);
  const gateway = await bridge.serve();

  assertEquals((await handshake(gateway.path, 'thread-1', firstToken)).ok, false);
  assertEquals((await handshake(gateway.path, 'thread-1', secondToken)).ok, true);
  now = new Date('2026-08-30T00:00:02.000Z');
  assertEquals((await handshake(gateway.path, 'thread-1', secondToken)).ok, false);

  await gateway.close();
  await Deno.remove(root, { recursive: true });
});

Deno.test('Thread-scoped MCP exposes only see and act and reaches the pinned broker', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-browser-mcp-' });
  const broker = new BrowserControlBroker('host-1');
  const calls: BrowserControlInvokeParams[] = [];
  broker.attach('principal-1', 'thread-1', {
    version: 1,
    clientId: 'alpha-1',
    tabId: 'tab-1',
    generation: 1,
    controlRevision: 0,
    platform: 'macOS',
    operations: ['see', 'act'],
    authorization: { observe: true, control: true },
    limits: { maxResultBytes: 64_000, maxScreenshotBytes: 32_000, maxElements: 20, maxDurationMs: 1_000 },
  }, {
    connectionId: 'connection-1',
    invoke: (params) => {
      calls.push(params);
      return Promise.resolve({
        requestId: params.requestId,
        leaseId: params.leaseId,
        address: params.address,
        view: {
          id: 'view-1',
          tabId: 'tab-1',
          generation: 1,
          controlRevision: 0,
          url: 'https://fixture.test/',
          loading: false,
          viewport: { width: 800, height: 600 },
          text: 'Fixture ready',
          elements: [],
          warnings: [],
        },
      });
    },
  });
  const bridge = new BrowserMcpBridge(root, broker);
  const descriptor = bridge.servers('thread-1')[0]!;
  if (descriptor.command.toLowerCase().endsWith('deno')) {
    assert(descriptor.args.includes(`--allow-read=${browserMcpSocketPath(root)}`));
    assert(descriptor.args.includes(`--allow-write=${browserMcpSocketPath(root)}`));
    assert(descriptor.args.includes(`--allow-net=unix:${browserMcpSocketPath(root)}`));
  }
  const env = Object.fromEntries(descriptor.env.map(({ name, value }) => [name, value]));
  const gateway = await bridge.serve();
  const input = new TransformStream<Uint8Array>();
  const output = new TransformStream<Uint8Array>();
  const received = collect(output.readable);
  const task = runBrowserMcp({
    path: env.WEAVE_BROWSER_MCP_SOCKET!,
    threadId: env.WEAVE_BROWSER_MCP_THREAD!,
    token: env.WEAVE_BROWSER_MCP_TOKEN!,
    stdin: input.readable,
    stdout: output.writable,
  });
  const writer = input.writable.getWriter();
  const send = (message: unknown) => writer.write(new TextEncoder().encode(`${JSON.stringify(message)}\n`));
  await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  await send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  await send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'browser_see',
      arguments: { wait: { kind: 'text', text: 'Fixture ready' } },
    },
  });
  await writer.close();
  await task;
  const messages = (await received).trim().split('\n').map((line) => JSON.parse(line));
  assertEquals(messages[1].result.tools.map(({ name }: { name: string }) => name), ['browser_see', 'browser_act']);
  assertEquals(messages[2].result.structuredContent.text, 'Fixture ready');
  assertEquals(calls[0]?.command, { kind: 'see', wait: { kind: 'text', text: 'Fixture ready' } });
  assert(!JSON.stringify(messages).includes('WEAVE_BROWSER_MCP_TOKEN'));
  await gateway.close();
  await Deno.remove(root, { recursive: true });
});

Deno.test('Thread-scoped MCP preserves typed broker failures as tool evidence', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-browser-mcp-error-' });
  const bridge = new BrowserMcpBridge(root, new BrowserControlBroker('host-1'));
  const descriptor = bridge.servers('thread-1')[0]!;
  const env = Object.fromEntries(descriptor.env.map(({ name, value }) => [name, value]));
  const gateway = await bridge.serve();
  const input = new TransformStream<Uint8Array>();
  const output = new TransformStream<Uint8Array>();
  const received = collect(output.readable);
  const task = runBrowserMcp({
    path: env.WEAVE_BROWSER_MCP_SOCKET!,
    threadId: env.WEAVE_BROWSER_MCP_THREAD!,
    token: env.WEAVE_BROWSER_MCP_TOKEN!,
    stdin: input.readable,
    stdout: output.writable,
  });
  const writer = input.writable.getWriter();
  await writer.write(new TextEncoder().encode(`${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_see', arguments: {} },
  })}\n`));
  await writer.close();
  await task;
  const [message] = (await received).trim().split('\n').map((line) => JSON.parse(line));
  assertEquals(message.result.isError, true);
  assertEquals(message.result.structuredContent.error, {
    code: 'NOT_ATTACHED',
    message: 'No visible Browser is attached to this Thread.',
    retryable: false,
  });
  await gateway.close();
  await Deno.remove(root, { recursive: true });
});

Deno.test('Thread-scoped MCP interrupts an in-flight lease and requires a fresh provider after reconnect', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-browser-mcp-reconnect-' });
  const broker = new BrowserControlBroker('host-1');
  let invocationStarted!: () => void;
  const started = new Promise<void>((resolve) => invocationStarted = resolve);
  const attach = (tabId: string, invoke: (params: BrowserControlInvokeParams, signal: AbortSignal) => Promise<unknown>) =>
    broker.attach('principal-1', 'thread-1', {
      version: 1,
      clientId: 'alpha-1',
      tabId,
      generation: 1,
      controlRevision: 0,
      platform: 'iPadOS',
      operations: ['see', 'act'],
      authorization: { observe: true, control: true },
      limits: { maxResultBytes: 64_000, maxScreenshotBytes: 32_000, maxElements: 20, maxDurationMs: 1_000 },
    }, { connectionId: `connection-${tabId}`, invoke });
  const firstLease = attach('tab-old', (_params, signal) => new Promise((_resolve, reject) => {
    invocationStarted();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const bridge = new BrowserMcpBridge(root, broker);
  const descriptor = bridge.servers('thread-1')[0]!;
  const env = Object.fromEntries(descriptor.env.map(({ name, value }) => [name, value]));
  const gateway = await bridge.serve();
  const input = new TransformStream<Uint8Array>();
  const output = new TransformStream<Uint8Array>();
  const received = collect(output.readable);
  const task = runBrowserMcp({
    path: env.WEAVE_BROWSER_MCP_SOCKET!,
    threadId: env.WEAVE_BROWSER_MCP_THREAD!,
    token: env.WEAVE_BROWSER_MCP_TOKEN!,
    stdin: input.readable,
    stdout: output.writable,
  });
  const writer = input.writable.getWriter();
  const send = (id: number) => writer.write(new TextEncoder().encode(`${JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'browser_see', arguments: {} },
  })}\n`));
  await send(1);
  await started;
  broker.detach(firstLease.leaseId);
  attach('tab-new', (params) => Promise.resolve({
    requestId: params.requestId,
    leaseId: params.leaseId,
    address: params.address,
    view: {
      id: 'fresh-view', tabId: 'tab-new', generation: 1, controlRevision: 0,
      url: 'https://fixture.test/', loading: false,
      viewport: { width: 800, height: 600 }, text: 'reconnected', elements: [], warnings: [],
    },
  }));
  await send(2);
  await writer.close();
  await task;
  const messages = (await received).trim().split('\n').map((line) => JSON.parse(line));
  assertEquals(messages[0].result.structuredContent.error.code, 'LEASE_REVOKED');
  assertEquals(messages[1].result.structuredContent.tabId, 'tab-new');
  assertEquals(messages[1].result.structuredContent.text, 'reconnected');
  await gateway.close();
  await Deno.remove(root, { recursive: true });
});
