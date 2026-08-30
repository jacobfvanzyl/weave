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
