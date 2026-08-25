import { PORTAL_TOKEN_PROTOCOL_PREFIX } from '@weave/product-protocol';
import { idKey, type JsonRpcMessage, parseJsonRpcMessage } from '../src/json-rpc.ts';

const required = (name: string) => {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const tokenProtocol = (token: string) => {
  const bytes = new TextEncoder().encode(token);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `${PORTAL_TOKEN_PROTOCOL_PREFIX}${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
};

class RpcResponseError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

class RpcSocket {
  readonly #socket: WebSocket;
  readonly #pending = new Map<string, { resolve(value: unknown): void; reject(cause: unknown): void }>();
  readonly notifications: JsonRpcMessage[] = [];
  #nextId = 0;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.onmessage = (event) => {
      const message = parseJsonRpcMessage(String(event.data));
      if (message.id !== undefined && message.method === undefined) {
        const pending = this.#pending.get(idKey(message.id));
        if (!pending) return;
        this.#pending.delete(idKey(message.id));
        if (message.error) {
          pending.reject(new RpcResponseError(message.error.code, message.error.message, message.error.data));
        } else pending.resolve(message.result);
      } else {
        this.notifications.push(message);
      }
    };
    socket.onclose = (event) => {
      for (const pending of this.#pending.values()) pending.reject(new Error(event.reason || 'WebSocket closed.'));
      this.#pending.clear();
    };
  }

  static async open(url: string, token: string) {
    const socket = new WebSocket(url, tokenProtocol(token));
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(`Could not open ${url}.`));
    });
    return new RpcSocket(socket);
  }

  request(method: string, params: unknown = {}) {
    const id = ++this.#nextId;
    const response = new Promise<unknown>((resolve, reject) => this.#pending.set(idKey(id), { resolve, reject }));
    this.#socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return response;
  }

  close() {
    this.#socket.close();
  }
}

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the acceptance condition.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const baseUrl = required('PORTAL_URL').replace(/\/$/, '');
const token = required('PORTAL_ACCESS_TOKEN');
const workspaceId = required('PORTAL_WORKSPACE_ID');
const agentId = required('PORTAL_AGENT_ID');
const marker = required('PORTAL_ACCEPTANCE_MARKER');
const recovery = Deno.env.get('PORTAL_ACCEPTANCE_RECOVERY') === 'true';
const existingThreadId = Deno.env.get('PORTAL_ACCEPTANCE_THREAD_ID')?.trim();
const expectedGeneration = Deno.env.get('PORTAL_ACCEPTANCE_EXPECTED_GENERATION')?.trim();
const rpc = await RpcSocket.open(`${baseUrl}/rpc`, token);
try {
  const thread = existingThreadId
    ? ((await rpc.request('thread.list') as { threads: Array<{ threadId: string; acpSessionId: string }> }).threads
      .find((candidate) => candidate.threadId === existingThreadId))
    : (await rpc.request('thread.create', { workspaceId, agentId, title: `Acceptance ${marker}` }) as {
      thread: { threadId: string; acpSessionId: string };
    }).thread;
  if (!thread) throw new Error(`Acceptance Thread is unavailable: ${existingThreadId}`);
  const attachment = await rpc.request('thread.attach', { threadId: thread.threadId }) as {
    connection: { path: string; threadId: string; cwd: string };
  };
  const acp = await RpcSocket.open(
    `${baseUrl}${attachment.connection.path}?threadId=${encodeURIComponent(attachment.connection.threadId)}`,
    token,
  );
  try {
    const initialized = await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    if (recovery && !JSON.stringify(initialized).includes('_weave.dev/runtime/state')) {
      throw new Error('Portal did not advertise runtime recovery.');
    }
    await acp.request('session/load', {
      sessionId: thread.acpSessionId,
      cwd: attachment.connection.cwd,
      mcpServers: [],
      ...(recovery ? { _meta: { 'weave.dev/threadEvents': { afterSequence: 0 } } } : {}),
    });
    const baseSequence = recovery
      ? Number(
        (acp.notifications.find((message) => message.method === '_weave.dev/thread_events/sync')?.params as {
          lastSequence?: unknown;
        } | undefined)?.lastSequence,
      )
      : 0;
    if (recovery && !Number.isInteger(baseSequence)) throw new Error('Portal did not establish a replay cursor.');
    await acp.request('session/prompt', {
      sessionId: thread.acpSessionId,
      prompt: [{ type: 'text', text: `Reply with exactly ${marker}` }],
    });
    const transcript = acp.notifications.map((message) => JSON.stringify(message)).join('\n');
    if (!transcript.includes(marker)) throw new Error(`Agent transcript did not contain ${marker}.`);
    if (recovery) {
      let uncertain: unknown;
      try {
        await acp.request('session/prompt', {
          sessionId: thread.acpSessionId,
          prompt: [{ type: 'text', text: 'CRASH_WITH_STALE_REMOTE_ACCEPTANCE' }],
        });
      } catch (cause) {
        uncertain = cause;
      }
      if (
        !(uncertain instanceof RpcResponseError) || uncertain.code !== -32050 ||
        (uncertain.data as { code?: unknown } | undefined)?.code !== 'PROMPT_UNCERTAIN'
      ) {
        throw new Error('Interrupted prompt did not return PROMPT_UNCERTAIN.');
      }
      if (
        expectedGeneration &&
        Number((uncertain.data as { generation?: unknown }).generation) !== Number(expectedGeneration)
      ) {
        throw new Error(`Interrupted prompt used an unexpected runtime generation: ${JSON.stringify(uncertain.data)}`);
      }
      await waitFor(() =>
        acp.notifications.some((message) =>
          message.method === '_weave.dev/runtime/state' &&
          (message.params as { code?: unknown }).code === 'RECOVERED'
        )
      );
      await new Promise((resolve) => setTimeout(resolve, 125));
      if (acp.notifications.some((message) => JSON.stringify(message).includes('OBSOLETE_PROVIDER_EVENT'))) {
        throw new Error('An obsolete provider generation reached the client.');
      }

      const recoveredMarker = `${marker}_RECOVERED`;
      await acp.request('session/prompt', {
        sessionId: thread.acpSessionId,
        prompt: [{ type: 'text', text: recoveredMarker }],
      });
      if (!acp.notifications.some((message) => JSON.stringify(message).includes(recoveredMarker))) {
        throw new Error('Fresh prompt did not complete after provider recovery.');
      }

      const reattached = await RpcSocket.open(
        `${baseUrl}${attachment.connection.path}?threadId=${encodeURIComponent(attachment.connection.threadId)}`,
        token,
      );
      try {
        await reattached.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
        await reattached.request('session/load', {
          sessionId: thread.acpSessionId,
          cwd: attachment.connection.cwd,
          mcpServers: [],
          _meta: { 'weave.dev/threadEvents': { afterSequence: baseSequence + 3 } },
        });
        if (!reattached.notifications.some((message) => JSON.stringify(message).includes(recoveredMarker))) {
          throw new Error('Cursor reattachment did not replay the recovered turn.');
        }
      } finally {
        reattached.close();
      }
    }
    console.log(JSON.stringify({ ok: true, threadId: thread.threadId, marker, recovery }));
  } finally {
    acp.close();
  }
} finally {
  rpc.close();
}
