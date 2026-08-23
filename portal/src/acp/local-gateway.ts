import { jsonRpcMessageSchema } from '@weave/protocol';
import { z } from 'zod';
import { acpRuntimeInternals, type AgentRuntimePort } from './runtime.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const maxControlBytes = 16 * 1024;

const handshakeSchema = z.object({
  protocol: z.literal('weave-host-acp/1'),
  agentId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  workspacePath: z.string().min(1).optional(),
  principalId: z.string().min(1),
}).strict().refine(
  (handshake) => Boolean(handshake.workspaceId) !== Boolean(handshake.workspacePath),
  { message: 'ACP connector must select exactly one Workspace.' },
);

const writeJsonLine = async (writer: WritableStreamDefaultWriter<Uint8Array>, value: unknown) => {
  await writer.write(encoder.encode(`${JSON.stringify(value)}\n`));
};

export type LocalAcpGateway = {
  readonly path: string;
  readonly finished: Promise<void>;
  close(): Promise<void>;
};

export const serveLocalAcpGateway = async (input: {
  path: string;
  runtimeManager: AgentRuntimePort;
}): Promise<LocalAcpGateway> => {
  const listener = Deno.listen({ transport: 'unix', path: input.path });
  await Deno.chmod(input.path, 0o600).catch(() => undefined);
  const connections = new Set<Deno.Conn>();
  let closing = false;

  const handle = async (connection: Deno.Conn) => {
    connections.add(connection);
    const writer = connection.writable.getWriter();
    let attachment: Awaited<ReturnType<AgentRuntimePort['attach']>> | undefined;
    try {
      const lines = acpRuntimeInternals.readLines(connection.readable, 4 * 1024 * 1024);
      const iterator = lines[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done) throw new Error('ACP connector closed before its handshake.');
      if (encoder.encode(first.value).byteLength > maxControlBytes) {
        throw new Error('ACP connector handshake is too large.');
      }
      const handshake = handshakeSchema.parse(JSON.parse(first.value));
      attachment = await input.runtimeManager.attach({
        agentId: handshake.agentId,
        workspaceId: handshake.workspaceId,
        workspacePath: handshake.workspacePath,
        principalId: handshake.principalId,
        transport: 'stdio',
      });
      await writeJsonLine(writer, { ok: true, protocol: 'weave-host-acp/1' });

      const outbound = (async () => {
        const reader = attachment!.messages.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await writeJsonLine(writer, value);
          }
        } finally {
          reader.releaseLock();
        }
      })();

      const inbound = (async () => {
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          if (!next.value.trim()) throw new Error('ACP connector sent an empty line.');
          await attachment!.receive(jsonRpcMessageSchema.parse(JSON.parse(next.value)));
        }
      })();

      await Promise.race([outbound, inbound]);
    } catch (error) {
      if (!attachment) {
        await writeJsonLine(writer, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
      }
    } finally {
      await attachment?.close('Local ACP connector detached.').catch(() => undefined);
      await writer.close().catch(() => undefined);
      try {
        connection.close();
      } catch {
        // Closing either stream may already have closed the Unix connection.
      }
      connections.delete(connection);
    }
  };

  const finished = (async () => {
    try {
      for await (const connection of listener) void handle(connection);
    } catch (error) {
      if (!closing) throw error;
    }
  })();

  return {
    path: input.path,
    finished,
    close: async () => {
      if (closing) return;
      closing = true;
      listener.close();
      for (const connection of connections) {
        try {
          connection.close();
        } catch {
          // A connection may have closed concurrently with gateway shutdown.
        }
      }
      await finished.catch(() => undefined);
      await Deno.remove(input.path).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    },
  };
};

export const runStdioAcpConnector = async (input: {
  path: string;
  agentId: string;
  workspaceId?: string;
  workspacePath?: string;
  principalId: string;
  stdin?: ReadableStream<Uint8Array>;
  stdout?: WritableStream<Uint8Array>;
}): Promise<void> => {
  const connection = await Deno.connect({ transport: 'unix', path: input.path });
  const writer = connection.writable.getWriter();
  const stdout = (input.stdout ?? Deno.stdout.writable).getWriter();
  const pendingRequestIds = new Set<string>();
  let inputEnded = false;
  let resolveDrained: (() => void) | undefined;
  const idKey = (id: string | number) => `${typeof id}:${String(id)}`;
  const waitForDrained = () => {
    if (pendingRequestIds.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      resolveDrained = resolve;
    });
  };
  try {
    const handshake = handshakeSchema.parse({
      protocol: 'weave-host-acp/1',
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      principalId: input.principalId,
    });
    await writeJsonLine(writer, handshake);
    const lines = acpRuntimeInternals.readLines(connection.readable, 4 * 1024 * 1024);
    const iterator = lines[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) throw new Error('Host Daemon closed before accepting the ACP connector.');
    const accepted = JSON.parse(first.value) as { ok?: boolean; error?: string };
    if (!accepted.ok) throw new Error(accepted.error || 'Host Daemon rejected the ACP connector.');

    const inbound = (async () => {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        if (!next.value.trim()) throw new Error('Host Daemon emitted an empty ACP line.');
        const message = jsonRpcMessageSchema.parse(JSON.parse(next.value));
        await stdout.write(encoder.encode(`${next.value}\n`));
        if (!('method' in message) && message.id !== null) {
          pendingRequestIds.delete(idKey(message.id));
          if (inputEnded && pendingRequestIds.size === 0) resolveDrained?.();
        }
      }
      if (pendingRequestIds.size) throw new Error('Host Daemon closed with pending ACP requests.');
    })();

    const outbound = (async () => {
      for await (const line of acpRuntimeInternals.readLines(input.stdin ?? Deno.stdin.readable, 4 * 1024 * 1024)) {
        if (!line.trim()) throw new Error('ACP client sent an empty line.');
        const message = jsonRpcMessageSchema.parse(JSON.parse(line));
        if ('method' in message && 'id' in message) pendingRequestIds.add(idKey(message.id));
        await writer.write(encoder.encode(`${line}\n`));
      }
      inputEnded = true;
      await waitForDrained();
    })();

    await outbound;
    try {
      connection.close();
    } catch {
      // The Host may already have closed after the final response.
    }
    await inbound.catch((error) => {
      if (!(error instanceof Deno.errors.Interrupted) && !(error instanceof Deno.errors.BadResource)) throw error;
    });
  } finally {
    writer.releaseLock();
    stdout.releaseLock();
    try {
      connection.close();
    } catch {
      // Closing the writer may already have closed the Unix connection.
    }
  }
};

export const localAcpGatewayInternals = {
  handshakeSchema,
  decode: (value: Uint8Array) => decoder.decode(value),
};
