import { dirname, fromFileUrl, join } from 'jsr:@std/path@1.1.2';
import { type BrowserControlCommand, parseBrowserControlCommand } from '@weave/product-protocol';
import { readLines } from './line-stream.ts';
import { BrowserControlBroker, BrowserControlError } from './browser-control.ts';

const protocol = 'weave-browser-mcp/1';
const encoder = new TextEncoder();
const maxLineBytes = 2 * 1024 * 1024;

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const writeLine = async (writer: WritableStreamDefaultWriter<Uint8Array>, value: unknown) => {
  await writer.write(encoder.encode(`${JSON.stringify(value)}\n`));
};

const checkedLine = (value: string) => {
  if (!value.trim() || encoder.encode(value).byteLength > maxLineBytes) {
    throw new Error('Browser MCP message is invalid.');
  }
  return value;
};

export const browserMcpSocketPath = (stateDirectory: string) => {
  const colocated = join(stateDirectory, 'browser-control.sock');
  if (encoder.encode(colocated).byteLength < 100) return colocated;
  let hash = 2166136261;
  for (const byte of encoder.encode(stateDirectory)) hash = Math.imul(hash ^ byte, 16777619);
  return `/tmp/weave-browser-${(hash >>> 0).toString(16).padStart(8, '0')}.sock`;
};

const executable = (socketPath: string) => {
  const deno = Deno.execPath();
  const main = fromFileUrl(new URL('./main.ts', import.meta.url));
  return deno.toLowerCase().endsWith('deno')
    ? {
      command: deno,
      args: [
        'run',
        '--allow-env=WEAVE_BROWSER_MCP_SOCKET,WEAVE_BROWSER_MCP_THREAD,WEAVE_BROWSER_MCP_TOKEN',
        `--allow-read=${socketPath}`,
        `--allow-write=${socketPath}`,
        `--allow-net=unix:${socketPath}`,
        main,
        'browser',
        'mcp',
      ],
    }
    : { command: deno, args: ['browser', 'mcp'] };
};

export class BrowserMcpBridge {
  readonly #tokens = new Map<string, string>();

  constructor(
    readonly stateDirectory: string,
    readonly broker: BrowserControlBroker,
  ) {}

  servers(threadId: string) {
    const token = crypto.randomUUID();
    this.#tokens.set(threadId, token);
    const socketPath = browserMcpSocketPath(this.stateDirectory);
    const process = executable(socketPath);
    return [{
      name: 'weave-visible-browser',
      command: process.command,
      args: process.args,
      env: [
        { name: 'WEAVE_BROWSER_MCP_SOCKET', value: socketPath },
        { name: 'WEAVE_BROWSER_MCP_THREAD', value: threadId },
        { name: 'WEAVE_BROWSER_MCP_TOKEN', value: token },
      ],
    }];
  }

  async serve() {
    const path = browserMcpSocketPath(this.stateDirectory);
    await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await Deno.remove(path).catch((cause) => {
      if (!(cause instanceof Deno.errors.NotFound)) throw cause;
    });
    const listener = Deno.listen({ transport: 'unix', path });
    await Deno.chmod(path, 0o600);
    const connections = new Set<Deno.Conn>();
    let closing = false;

    const handle = async (connection: Deno.Conn) => {
      connections.add(connection);
      const writer = connection.writable.getWriter();
      try {
        const lines = readLines(connection.readable)[Symbol.asyncIterator]();
        const first = await lines.next();
        if (first.done) throw new Error('Browser MCP bridge closed before authentication.');
        const handshake = object(JSON.parse(checkedLine(first.value)));
        const threadId = typeof handshake.threadId === 'string' ? handshake.threadId : '';
        const token = typeof handshake.token === 'string' ? handshake.token : '';
        if (handshake.protocol !== protocol || !threadId || this.#tokens.get(threadId) !== token) {
          throw new Error('Browser MCP bridge authentication failed.');
        }
        await writeLine(writer, { ok: true, protocol });
        while (true) {
          const next = await lines.next();
          if (next.done) break;
          const request = object(JSON.parse(checkedLine(next.value)));
          const id = request.id;
          try {
            const command = parseBrowserControlCommand(request.command);
            const result = await this.broker.invoke(threadId, command);
            await writeLine(writer, { id, result });
          } catch (cause) {
            const failure = cause instanceof BrowserControlError ? cause : new BrowserControlError(
              'UNSUPPORTED',
              cause instanceof Error ? cause.message : 'Browser control failed.',
            );
            await writeLine(writer, { id, error: { message: failure.message, data: failure.data } });
          }
        }
      } catch (cause) {
        await writeLine(writer, { ok: false, error: cause instanceof Error ? cause.message : String(cause) }).catch(
          () => undefined,
        );
      } finally {
        await writer.close().catch(() => undefined);
        try {
          connection.close();
        } catch { /* already closed */ }
        connections.delete(connection);
      }
    };

    const finished = (async () => {
      try {
        for await (const connection of listener) void handle(connection);
      } catch (cause) {
        if (!closing) throw cause;
      }
    })();
    return {
      path,
      finished,
      close: async () => {
        if (closing) return;
        closing = true;
        listener.close();
        for (const connection of connections) {
          try {
            connection.close();
          } catch { /* closing concurrently */ }
        }
        await finished.catch(() => undefined);
        await Deno.remove(path).catch((cause) => {
          if (!(cause instanceof Deno.errors.NotFound)) throw cause;
        });
      },
    };
  }
}

const conditionSchema = {
  oneOf: [
    {
      type: 'object',
      properties: { kind: { const: 'text' }, text: { type: 'string' } },
      required: ['kind', 'text'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { kind: { const: 'url' }, includes: { type: 'string' } },
      required: ['kind', 'includes'],
      additionalProperties: false,
    },
  ],
} as const;

const actionSchema = {
  oneOf: [
    {
      type: 'object',
      properties: { kind: { const: 'click' }, target: { type: 'string' } },
      required: ['kind', 'target'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { kind: { const: 'fill' }, target: { type: 'string' }, text: { type: 'string' } },
      required: ['kind', 'target', 'text'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { kind: { const: 'key' }, key: { type: 'string' } },
      required: ['kind', 'key'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        kind: { const: 'scroll' },
        direction: { enum: ['up', 'down'] },
        amount: { enum: ['small', 'page'] },
      },
      required: ['kind', 'direction'],
      additionalProperties: false,
    },
  ],
} as const;

const tools = [
  {
    name: 'browser_see',
    description: 'Observe or navigate the exact visible Alpha Browser attached to this Thread.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Optional HTTP(S) URL to navigate to before observing.' },
        screenshot: { type: 'boolean' },
        wait: conditionSchema,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_act',
    description: 'Perform one semantic action against a fresh Browser view and return new evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        viewId: { type: 'string' },
        action: actionSchema,
        expect: conditionSchema,
        screenshot: { type: 'boolean' },
      },
      required: ['viewId', 'action'],
      additionalProperties: false,
    },
  },
] as const;

const toolResult = (view: Record<string, unknown>) => {
  const screenshot = object(view.screenshot);
  const visible = { ...view };
  delete visible.screenshot;
  return {
    content: [
      { type: 'text', text: JSON.stringify(visible) },
      ...(screenshot.data ? [{ type: 'image', mimeType: 'image/png', data: screenshot.data }] : []),
    ],
    structuredContent: visible,
    isError: false,
  };
};

const toolFailure = (error: Record<string, unknown>) => {
  const data = object(error.data);
  const failure = {
    code: typeof data.code === 'string' ? data.code : 'UNSUPPORTED',
    message: typeof error.message === 'string' ? error.message : 'Browser control failed.',
    retryable: data.retryable === true,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: failure }) }],
    structuredContent: { error: failure },
    isError: true,
  };
};

export const runBrowserMcp = async (input: {
  path: string;
  threadId: string;
  token: string;
  stdin?: ReadableStream<Uint8Array>;
  stdout?: WritableStream<Uint8Array>;
}) => {
  const connection = await Deno.connect({ transport: 'unix', path: input.path });
  const gatewayWriter = connection.writable.getWriter();
  const gatewayLines = readLines(connection.readable)[Symbol.asyncIterator]();
  const output = (input.stdout ?? Deno.stdout.writable).getWriter();
  await writeLine(gatewayWriter, { protocol, threadId: input.threadId, token: input.token });
  const accepted = await gatewayLines.next();
  if (accepted.done || object(JSON.parse(checkedLine(accepted.value))).ok !== true) {
    throw new Error('Portal rejected the Browser MCP server.');
  }
  try {
    for await (const line of readLines(input.stdin ?? Deno.stdin.readable)) {
      const message = object(JSON.parse(checkedLine(line)));
      if (message.method === 'notifications/initialized') continue;
      if (message.id === undefined) continue;
      let response: unknown;
      try {
        if (message.method === 'initialize') {
          response = {
            protocolVersion: '2025-06-18',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'Weave Visible Browser', version: '0.1.0' },
          };
        } else if (message.method === 'tools/list') {
          response = { tools };
        } else if (message.method === 'tools/call') {
          const params = object(message.params);
          const args = object(params.arguments);
          const command: BrowserControlCommand = params.name === 'browser_see'
            ? parseBrowserControlCommand({ kind: 'see', ...args })
            : params.name === 'browser_act'
            ? parseBrowserControlCommand({ kind: 'act', ...args })
            : (() => {
              throw new Error('Unknown Browser tool.');
            })();
          await writeLine(gatewayWriter, { id: message.id, command });
          const bridgeResponse = await gatewayLines.next();
          if (bridgeResponse.done) throw new Error('Portal closed the Browser MCP bridge.');
          const bridged = object(JSON.parse(checkedLine(bridgeResponse.value)));
          response = bridged.error
            ? toolFailure(object(bridged.error))
            : toolResult(object(object(bridged.result).view));
        } else throw new Error('Method not found.');
        await writeLine(output, { jsonrpc: '2.0', id: message.id, result: response });
      } catch (cause) {
        await writeLine(output, {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: cause instanceof Error ? cause.message : String(cause) },
        });
      }
    }
  } finally {
    await output.close().catch(() => undefined);
    await gatewayWriter.close().catch(() => undefined);
    try {
      connection.close();
    } catch { /* already closed */ }
  }
};
