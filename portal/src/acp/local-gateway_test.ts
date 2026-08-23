import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { AgentRuntimeManager } from './runtime.ts';
import { AcpSessionBroker } from './session-broker.ts';
import { runStdioAcpConnector, serveLocalAcpGateway } from './local-gateway.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const collect = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  let result = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return result;
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
};

Deno.test('local Host gateway carries a complete ACP prompt over the stdio connector', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'weave-host-acp-' });
  const socketPath = `${directory}/host.sock`;
  const fixturePath = decodeURIComponent(new URL('./test-fixtures/fake-agent.ts', import.meta.url).pathname);
  const manager = new AcpSessionBroker(
    new AgentRuntimeManager(
      [{
        id: 'fake',
        name: 'Fake Agent',
        command: Deno.execPath(),
        args: ['run', '--quiet', fixturePath],
      }],
      {
        resolveWorkspace: async (selection, principalId) => {
          assertEquals(selection, { workspaceId: undefined, workspacePath: directory });
          assertEquals(principalId, 'local-user');
          return { workspaceId: 'workspace-1', path: directory };
        },
        closeGraceMs: 100,
      },
    ),
  );
  const gateway = await serveLocalAcpGateway({ path: socketPath, runtimeManager: manager });
  const clientInput = new TransformStream<Uint8Array>();
  const clientOutput = new TransformStream<Uint8Array>();
  const output = collect(clientOutput.readable);
  const connector = runStdioAcpConnector({
    path: socketPath,
    agentId: 'fake',
    workspacePath: directory,
    principalId: 'local-user',
    stdin: clientInput.readable,
    stdout: clientOutput.writable,
  });

  try {
    const writer = clientInput.writable.getWriter();
    for (
      const message of [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'test', version: '1' } },
        },
        { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: directory, mcpServers: [] } },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'session/prompt',
          params: { sessionId: 'fake-session-1', prompt: [{ type: 'text', text: 'hello' }] },
        },
      ]
    ) {
      await writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
    }
    await writer.close();
    await connector;
    await clientOutput.writable.close();

    const messages = (await output).trim().split('\n').map((line) => JSON.parse(line));
    assertEquals(messages[0].id, 1);
    assertEquals(messages[0].result.protocolVersion, 1);
    assertEquals(messages[1], { jsonrpc: '2.0', id: 2, result: { sessionId: 'fake-session-1' } });
    assertEquals(messages[2].method, 'session/update');
    assertStringIncludes(messages[2].params.update.content.text, 'fake response');
    assertEquals(messages[3], { jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
  } finally {
    await gateway.close();
    await manager.close();
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('local Host gateway rejects an unavailable Agent before ACP initialization', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'weave-host-acp-reject-' });
  const socketPath = `${directory}/host.sock`;
  const manager = new AcpSessionBroker(
    new AgentRuntimeManager([], {
      resolveWorkspace: async () => ({ workspaceId: 'workspace-1', path: directory }),
    }),
  );
  const gateway = await serveLocalAcpGateway({ path: socketPath, runtimeManager: manager });
  const input = new TransformStream<Uint8Array>();
  const output = new TransformStream<Uint8Array>();
  const connector = runStdioAcpConnector({
    path: socketPath,
    agentId: 'missing',
    workspaceId: 'workspace-1',
    principalId: 'local-user',
    stdin: input.readable,
    stdout: output.writable,
  });

  try {
    await input.writable.close();
    const error = await connector.then(() => '', (cause) => cause instanceof Error ? cause.message : String(cause));
    assertStringIncludes(error, 'Unknown or unavailable Agent: missing');
  } finally {
    await gateway.close();
    await manager.close();
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
