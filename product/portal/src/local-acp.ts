import { lstat } from 'node:fs/promises';
import { recoverStaleSocket, removeOwnedSocket } from './local-socket.ts';
import { createServer } from 'node:net';
import { localStream, connectLocal, stdinStream, stdoutStream, type LocalStream } from './local-stream.ts';
import { chmod, mkdir, removePath } from './host-files.ts';
import { isFsError } from './host-files.ts';
import { dirname, join } from 'node:path';
import type { PortalConfig } from './config.ts';
import { error, type JsonRpcMessage, parseJsonRpcMessage, result } from './json-rpc.ts';
import { readLines } from './line-stream.ts';
import { type LocalAcpContext, Portal } from './portal.ts';

const encoder = new TextEncoder();
const maxLineBytes = 4 * 1024 * 1024;
const maxHandshakeBytes = 16 * 1024;
const pageSize = 100;
const gatewayProtocol = 'weave-product-acp/1';
const sessionPrefix = 'weave-v1:';
const cursorPrefix = 'weave-page-v1:';

type Handshake = {
  protocol: typeof gatewayProtocol;
  agentId: string;
  executionContextId?: string;
  workspacePath?: string;
};

const objectFrom = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const base64Url = (value: string) => btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

const fromBase64Url = (value: string) => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return atob(padded);
};

const externalSessionId = (hostId: string, threadId: string) =>
  `${sessionPrefix}${base64Url(JSON.stringify([hostId, threadId]))}`;

const threadIdFromExternalSession = (hostId: string, sessionId: unknown) => {
  if (typeof sessionId !== 'string' || !sessionId.startsWith(sessionPrefix)) {
    throw new Error('Thread session is unavailable.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(sessionId.slice(sessionPrefix.length)));
  } catch {
    throw new Error('Thread session is unavailable.');
  }
  if (
    !Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== hostId ||
    typeof parsed[1] !== 'string' || !parsed[1]
  ) {
    throw new Error('Thread session is unavailable.');
  }
  return parsed[1];
};

const cursorFrom = (value: unknown) => {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'string' || !value.startsWith(cursorPrefix)) throw new Error('Session cursor is invalid.');
  const offset = Number(fromBase64Url(value.slice(cursorPrefix.length)));
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Session cursor is invalid.');
  return offset;
};

const cursorFor = (offset: number) => `${cursorPrefix}${base64Url(String(offset))}`;

const parseHandshake = (value: unknown): Handshake => {
  const input = objectFrom(value);
  const agentId = typeof input.agentId === 'string' ? input.agentId.trim() : '';
  const executionContextId = typeof input.executionContextId === 'string' ? input.executionContextId.trim() : undefined;
  const workspacePath = typeof input.workspacePath === 'string' ? input.workspacePath.trim() : undefined;
  if (
    input.protocol !== gatewayProtocol || !agentId ||
    Boolean(executionContextId) === Boolean(workspacePath)
  ) {
    throw new Error('Invalid local ACP connector handshake.');
  }
  return {
    protocol: gatewayProtocol,
    agentId,
    ...(executionContextId ? { executionContextId } : {}),
    ...(workspacePath ? { workspacePath } : {}),
  };
};

const checkedLine = (line: string, context: string, maximum = maxLineBytes) => {
  if (!line.trim()) throw new Error(`${context} emitted an empty line.`);
  if (encoder.encode(line).byteLength > maximum) throw new Error(`${context} message is too large.`);
  return line;
};

const writeJsonLine = async (writer: WritableStreamDefaultWriter<Uint8Array>, value: unknown) => {
  await writer.write(encoder.encode(`${JSON.stringify(value)}\n`));
};

const withSessionId = (message: JsonRpcMessage, from: string, to: string): JsonRpcMessage => {
  const params = objectFrom(message.params);
  const response = objectFrom(message.result);
  return {
    ...message,
    ...(message.params === undefined
      ? {}
      : { params: params.sessionId === from ? { ...params, sessionId: to } : message.params }),
    ...(message.result === undefined
      ? {}
      : { result: response.sessionId === from ? { ...response, sessionId: to } : message.result }),
  };
};

class LocalAcpSession {
  readonly #portal: Portal;
  readonly #context: LocalAcpContext;
  readonly #send: (message: JsonRpcMessage) => void;
  #attachment?: Awaited<ReturnType<Portal['connectLocalAcpThread']>>;
  #thread?: { threadId: string; acpSessionId: string; externalSessionId: string };
  #initialized = false;
  #closed = false;
  readonly #pendingMethods = new Map<string, string>();

  constructor(portal: Portal, context: LocalAcpContext, send: (message: JsonRpcMessage) => void) {
    this.#portal = portal;
    this.#context = context;
    this.#send = send;
  }

  async receive(message: JsonRpcMessage) {
    if (this.#closed || !message.method || message.id === undefined) {
      if (!this.#closed && this.#attachment) await this.#attachment.receive(this.#toRuntime(message));
      return;
    }
    try {
      if (message.method === 'initialize') {
        this.#initialized = true;
        this.#send(result(message.id, {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { list: {}, resume: {}, close: {} },
          },
          agentInfo: { name: `Weave · ${this.#context.agentName}`, version: '0.1.0' },
        }));
        return;
      }
      if (!this.#initialized) throw new Error('ACP connector is not initialized.');
      if (message.method === 'session/list') {
        const params = objectFrom(message.params);
        const offset = cursorFrom(params.cursor);
        const threads = this.#portal.listLocalAcpThreads(this.#context);
        const page = threads.slice(offset, offset + pageSize);
        this.#send(result(message.id, {
          sessions: page.map((thread) => ({
            sessionId: externalSessionId(this.#context.hostId, thread.threadId),
            cwd: this.#context.cwd,
            title: thread.title || this.#context.workspaceName,
            updatedAt: thread.updatedAt,
            _meta: { 'weave.dev/thread-status': thread.status },
          })),
          ...(offset + page.length < threads.length ? { nextCursor: cursorFor(offset + page.length) } : {}),
        }));
        return;
      }
      if (message.method === 'session/new') {
        const thread = await this.#portal.createLocalAcpThread(this.#context);
        await this.#activate(thread);
        await this.#forward({
          ...message,
          method: 'session/load',
          params: {
            ...objectFrom(message.params),
            sessionId: this.#thread!.externalSessionId,
          },
        }, 'session/new');
        return;
      }
      if (message.method === 'session/load' || message.method === 'session/resume') {
        const threadId = threadIdFromExternalSession(
          this.#context.hostId,
          objectFrom(message.params).sessionId,
        );
        const thread = this.#portal.listLocalAcpThreads(this.#context).find((candidate) =>
          candidate.threadId === threadId
        );
        if (!thread) throw new Error('Thread session is unavailable.');
        await this.#activate(thread);
        await this.#forward(message, message.method);
        return;
      }
      if (message.method === 'session/close') {
        this.#assertActiveSession(objectFrom(message.params).sessionId);
        this.#attachment?.close();
        this.#attachment = undefined;
        this.#thread = undefined;
        this.#send(result(message.id, {}));
        return;
      }
      if (message.method === 'session/delete') {
        this.#send(error(message.id, -32601, 'Portal does not support session/delete.'));
        return;
      }
      if (!this.#attachment || !this.#thread) throw new Error('No Thread session is active.');
      this.#assertActiveSession(objectFrom(message.params).sessionId);
      await this.#forward(message, message.method);
    } catch (cause) {
      this.#send(error(message.id, -32000, cause instanceof Error ? cause.message : String(cause)));
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#attachment?.close();
    this.#attachment = undefined;
    this.#thread = undefined;
  }

  async #activate(thread: { threadId: string; acpSessionId: string }) {
    if (this.#thread?.threadId === thread.threadId && this.#attachment) return;
    this.#attachment?.close();
    const active = {
      threadId: thread.threadId,
      acpSessionId: thread.acpSessionId,
      externalSessionId: externalSessionId(this.#context.hostId, thread.threadId),
    };
    this.#thread = active;
    try {
      const connection = await this.#portal.connectLocalAcpThread(
        this.#context,
        thread.threadId,
        (message) => this.#receiveRuntime(message),
      );
      active.acpSessionId = connection.acpSessionId;
      this.#attachment = connection;
    } catch (cause) {
      if (this.#thread === active) this.#thread = undefined;
      throw cause;
    }
  }

  async #forward(message: JsonRpcMessage, method: string) {
    if (!this.#attachment || !this.#thread) throw new Error('No Thread session is active.');
    this.#pendingMethods.set(`${typeof message.id}:${String(message.id)}`, method);
    await this.#attachment.receive(this.#toRuntime(message));
  }

  #toRuntime(message: JsonRpcMessage) {
    if (!this.#thread) return message;
    return withSessionId(message, this.#thread.externalSessionId, this.#thread.acpSessionId);
  }

  #receiveRuntime(message: JsonRpcMessage) {
    if (!this.#thread) return;
    const key = message.id === undefined ? undefined : `${typeof message.id}:${String(message.id)}`;
    const method = key ? this.#pendingMethods.get(key) : undefined;
    if (key && message.method === undefined) this.#pendingMethods.delete(key);
    let outgoing = withSessionId(message, this.#thread.acpSessionId, this.#thread.externalSessionId);
    if (method === 'session/new' && outgoing.result && !outgoing.error) {
      outgoing = {
        ...outgoing,
        result: { ...objectFrom(outgoing.result), sessionId: this.#thread.externalSessionId },
      };
    }
    this.#send(outgoing);
  }

  #assertActiveSession(sessionId: unknown) {
    if (!this.#thread || sessionId !== this.#thread.externalSessionId) {
      throw new Error('Thread session is unavailable.');
    }
  }
}

export type LocalAcpGateway = {
  path: string;
  finished: Promise<void>;
  close(): Promise<void>;
};

export const localAcpSocketPath = async (config: Pick<PortalConfig, 'stateDirectory'>) => {
  const colocated = join(config.stateDirectory, 'portal-acp.sock');
  if (encoder.encode(colocated).byteLength < 100) return colocated;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(config.stateDirectory)));
  const suffix = [...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `/tmp/weave-product-portal-${suffix}.sock`;
};

export const serveLocalAcpGateway = async (portal: Portal): Promise<LocalAcpGateway> => {
  const path = await localAcpSocketPath(portal.config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await recoverStaleSocket(path);
  const connections = new Set<LocalStream>();
  let closing = false;

  const handle = async (connection: LocalStream) => {
    connections.add(connection);
    const writer = connection.writable.getWriter();
    let outputQueue = Promise.resolve();
    let session: LocalAcpSession | undefined;
    const send = (message: JsonRpcMessage) => {
      outputQueue = outputQueue.then(() => writeJsonLine(writer, message));
    };
    try {
      const iterator = readLines(connection.readable)[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done) throw new Error('ACP connector closed before its handshake.');
      const handshake = parseHandshake(JSON.parse(checkedLine(first.value, 'ACP connector', maxHandshakeBytes)));
      const context = await portal.resolveLocalAcpContext(handshake);
      session = new LocalAcpSession(portal, context, send);
      await writeJsonLine(writer, { ok: true, protocol: gatewayProtocol });

      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        await session.receive(parseJsonRpcMessage(checkedLine(next.value, 'ACP connector')));
      }
    } catch (cause) {
      if (!session) {
        await writeJsonLine(writer, {
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
        }).catch(() => undefined);
      }
    } finally {
      session?.close();
      await outputQueue.catch(() => undefined);
      await writer.close().catch(() => undefined);
      try {
        connection.close();
      } catch {
        // Closing the streams may already have closed the Unix connection.
      }
      connections.delete(connection);
    }
  };

  const listener = createServer((socket) => { void handle(localStream(socket)); });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    const previousMask = process.umask(0o077);
    try {
      listener.listen(path, () => { listener.off('error', reject); resolve(); });
    } finally { process.umask(previousMask); }
  });
  await chmod(path, 0o600);
  const socketIdentity = await lstat(path);
  const finished = new Promise<void>((resolve, reject) => {
    listener.once('close', resolve);
    listener.once('error', reject);
  });

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
        } catch {
          // A connection may close concurrently with gateway shutdown.
        }
      }
      await finished.catch(() => undefined);
      await removeOwnedSocket(path, socketIdentity).catch((cause) => {
        if (!(isFsError(cause, 'ENOENT'))) throw cause;
      });
    },
  };
};

export const runStdioAcpConnector = async (input: {
  path: string;
  agentId: string;
  executionContextId?: string;
  workspacePath?: string;
  stdin?: ReadableStream<Uint8Array>;
  stdout?: WritableStream<Uint8Array>;
}) => {
  const connection = await connectLocal(input.path);
  const writer = connection.writable.getWriter();
  const stdout = (input.stdout ?? stdoutStream()).getWriter();
  const inputAbort = new AbortController();
  const pending = new Set<string>();
  let inputEnded = false;
  let resolveDrained: (() => void) | undefined;
  const waitForDrained = () =>
    pending.size === 0 ? Promise.resolve() : new Promise<void>((resolve) => resolveDrained = resolve);
  try {
    await writeJsonLine(
      writer,
      parseHandshake({
        protocol: gatewayProtocol,
        agentId: input.agentId,
        executionContextId: input.executionContextId,
        workspacePath: input.workspacePath,
      }),
    );
    const iterator = readLines(connection.readable)[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) throw new Error('Portal closed before accepting the ACP connector.');
    const accepted = objectFrom(JSON.parse(checkedLine(first.value, 'Portal', maxHandshakeBytes)));
    if (accepted.ok !== true) {
      throw new Error(typeof accepted.error === 'string' ? accepted.error : 'Portal rejected ACP.');
    }

    const inbound = (async () => {
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          const line = checkedLine(next.value, 'Portal');
          const message = parseJsonRpcMessage(line);
          await stdout.write(encoder.encode(`${line}\n`));
          if (message.id !== undefined && message.method === undefined) {
            pending.delete(`${typeof message.id}:${String(message.id)}`);
            if (inputEnded && pending.size === 0) resolveDrained?.();
          }
        }
        if (pending.size) throw new Error('Portal closed with pending ACP requests.');
      } finally {
        inputAbort.abort();
      }
    })();

    const outbound = (async () => {
      try {
        for await (const line of readLines(input.stdin ?? stdinStream(), inputAbort.signal)) {
          const checked = checkedLine(line, 'ACP client');
          const message = parseJsonRpcMessage(checked);
          if (message.method && message.id !== undefined) pending.add(`${typeof message.id}:${String(message.id)}`);
          await writer.write(encoder.encode(`${checked}\n`));
        }
        if (inputAbort.signal.aborted) return;
        inputEnded = true;
        await waitForDrained();
      } finally {
        try {
          connection.close();
        } catch {
          // Portal may close after its final response.
        }
      }
    })();

    await Promise.all([inbound, outbound]).catch((cause) => {
      if (!(isFsError(cause, 'EINTR')) && !(isFsError(cause, 'EBADF'))) throw cause;
    });
  } finally {
    inputAbort.abort();
    writer.releaseLock();
    stdout.releaseLock();
    try {
      connection.close();
    } catch {
      // Closing one stream may already close the Unix connection.
    }
  }
};

export const localAcpInternals = {
  externalSessionId,
  threadIdFromExternalSession,
};
