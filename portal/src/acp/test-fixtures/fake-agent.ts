const encoder = new TextEncoder();
const decoder = new TextDecoder();
const writer = Deno.stdout.writable.getWriter();
let pending = '';
let writeQueue = Promise.resolve();

const send = async (message: unknown) => {
  const write = writeQueue.then(() => writer.write(encoder.encode(`${JSON.stringify(message)}\n`)));
  writeQueue = write.then(() => undefined, () => undefined);
  await write;
};

const handle = async (message: Record<string, unknown>) => {
  const id = message.id;
  const method = message.method;
  if (method === 'initialize') {
    return await send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        agentInfo: { name: 'weave-fake-agent', title: 'Weave Fake Agent', version: '0.1.0' },
        authMethods: [],
      },
    });
  }
  if (method === 'session/new') {
    return await send({ jsonrpc: '2.0', id, result: { sessionId: 'fake-session-1' } });
  }
  if (method === 'session/prompt') {
    await send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'fake-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'fake response' },
        },
      },
    });
    return await send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
  }
  if (method === 'session/cancel') return;
  if (id !== undefined) {
    await send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${String(method)}` },
    });
  }
};

for await (const chunk of Deno.stdin.readable) {
  pending += decoder.decode(chunk, { stream: true });
  while (true) {
    const newline = pending.indexOf('\n');
    if (newline < 0) break;
    const line = pending.slice(0, newline).replace(/\r$/, '');
    pending = pending.slice(newline + 1);
    if (line.trim()) await handle(JSON.parse(line));
  }
}

await writeQueue;
await writer.close();
