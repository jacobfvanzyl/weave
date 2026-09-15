// Deterministic ACP agent: forwards requested tool calls through the injected MCP server.
import { createInterface } from 'node:readline';
import { Client, StdioClientTransport } from '../browser-tools/node_modules/chrome-devtools-mcp/build/src/third_party/index.js';
let descriptor, client, transport;
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const sessionId = 'browser-acceptance-agent';
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line); if (request.id === undefined) continue;
  try {
    let result = {};
    if (request.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'Browser acceptance', version: '1' } };
    else if (request.method === 'session/new') { descriptor = request.params.mcpServers[0]; result = { sessionId }; }
    else if (request.method === 'session/load') { descriptor ??= request.params.mcpServers[0]; }
    else if (request.method === 'session/prompt') {
      if (!descriptor) throw new Error('Portal did not inject browser MCP');
      if (!client) {
        transport = new StdioClientTransport({ command: descriptor.command, args: descriptor.args, env: { ...process.env, ...Object.fromEntries(descriptor.env.map(item => [item.name, item.value])) }, stderr: 'inherit' });
        client = new Client({ name: 'weave-acceptance-agent', version: '1' }); await client.connect(transport);
      }
      const call = JSON.parse(request.params.prompt[0].text);
      const tool = call.name === 'tools/list' ? { ...await client.listTools(), instructions: client.getInstructions() } : await client.callTool({ name: call.name, arguments: call.arguments ?? {} });
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(tool) } } } });
      result = { stopReason: 'end_turn' };
    }
    send({ id: request.id, result });
  } catch (error) { send({ id: request.id, error: { code: -32000, message: String(error) } }); }
}
await client?.close(); await transport?.close();
