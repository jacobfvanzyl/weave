import { type JsonRpcMessage, parseJsonRpcMessage, result } from '../json-rpc.ts';
import { readLines } from '../line-stream.ts';

const encoder = new TextEncoder();
const writer = Deno.stdout.writable.getWriter();
const send = async (message: JsonRpcMessage) => await writer.write(encoder.encode(`${JSON.stringify(message)}\n`));

for await (const line of readLines(Deno.stdin.readable)) {
  if (!line.trim()) continue;
  const message = parseJsonRpcMessage(line);
  if (message.id === undefined || !message.method) continue;
  if (message.method === 'initialize') {
    await send(result(message.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: 'Fake ACP Agent', version: '1.0.0' },
    }));
    continue;
  }
  if (message.method === 'session/new') {
    await send(result(message.id, { sessionId: 'fake-session' }));
    continue;
  }
  if (message.method === 'session/load') {
    await send(result(message.id, null));
    continue;
  }
  if (message.method === 'session/prompt') {
    const prompt = (message.params as { prompt?: Array<{ text?: unknown }> } | undefined)?.prompt
      ?.map((content) => typeof content.text === 'string' ? content.text : '')
      .join('') ?? '';
    if (prompt.includes('SLOW')) await new Promise((resolve) => setTimeout(resolve, 100));
    await send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'fake-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `FAKE_AGENT:${prompt}` } },
      },
    });
    await send(result(message.id, { stopReason: 'end_turn' }));
  }
}
