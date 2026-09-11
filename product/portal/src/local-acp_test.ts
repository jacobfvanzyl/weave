import { fileURLToPath } from 'node:url';
import { test } from './test-support.ts';
import { mkdir, realpath, removePath, temporaryDirectory } from './host-files.ts';
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from './test-support.ts';
import { dirname, join } from 'node:path';
import type { PortalConfig } from './config.ts';
import { localAcpInternals, runStdioAcpConnector, serveLocalAcpGateway } from './local-acp.ts';
import { type JsonRpcMessage, request } from './json-rpc.ts';
import { Portal } from './portal.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const collect = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  let output = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return output;
      output += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
};

const exchange = async (
  path: string,
  workspacePath: string,
  messages: JsonRpcMessage[],
) => {
  const input = new TransformStream<Uint8Array>();
  const output = new TransformStream<Uint8Array>();
  const collected = collect(output.readable);
  const connector = runStdioAcpConnector({
    path,
    agentId: 'fake',
    workspacePath,
    stdin: input.readable,
    stdout: output.writable,
  });
  const writer = input.writable.getWriter();
  for (const message of messages) {
    await writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
  }
  await writer.close();
  await connector;
  await output.writable.close();
  return (await collected).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as JsonRpcMessage);
};

test('Zed-facing local ACP lists, reloads, resumes, and continues a Portal-owned Thread', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-product-zed-import-' });
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath);
  const fakeAgent = join(dirname(fileURLToPath(import.meta.url)), 'test-fixtures', 'fake-agent.ts');
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    displayName: 'Zed Import Portal',
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    executionContexts: [{ executionContextId: 'workspace', name: 'Workspace', path: workspacePath }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: process.execPath,
      args: [fakeAgent],
      env: {},
    }],
  };

  let portal = await Portal.open(config);
  let gateway = await serveLocalAcpGateway(portal);
  try {
    const context = await portal.resolveLocalAcpContext({ agentId: 'fake', workspacePath });
    const thread = await portal.createLocalAcpThread(context, 'Alpha-created acceptance');
    const seedNotifications: JsonRpcMessage[] = [];
    let seedResolve: ((message: JsonRpcMessage) => void) | undefined;
    const seedResponse = new Promise<JsonRpcMessage>((resolve) => seedResolve = resolve);
    const seed = await portal.connectLocalAcpThread(context, thread.threadId, (message) => {
      if (message.id === 1 && message.method === undefined) seedResolve?.(message);
      else seedNotifications.push(message);
    });
    await seed.receive(request(0, 'initialize', { protocolVersion: 1, clientCapabilities: {} }));
    await seed.receive(request(2, 'session/load', {
      sessionId: thread.acpSessionId,
      cwd: workspacePath,
      mcpServers: [],
    }));
    await seed.receive(request(1, 'session/prompt', {
      sessionId: thread.acpSessionId,
      prompt: [{ type: 'text', text: 'FROM_ALPHA' }],
    }));
    await seedResponse;
    assert(seedNotifications.some((message) => JSON.stringify(message).includes('FAKE_AGENT:FROM_ALPHA')));
    seed.close();

    const first = await exchange(gateway.path, workspacePath, [
      request(10, 'initialize', { protocolVersion: 1, clientCapabilities: {} }),
      request(11, 'session/list', {}),
    ]);
    const initialized = first.find((message) => message.id === 10)!;
    const capabilities = (initialized.result as { agentCapabilities: Record<string, unknown> }).agentCapabilities;
    assertEquals(capabilities.loadSession, true);
    assertEquals(capabilities.sessionCapabilities, { list: {}, resume: {}, close: {} });
    assertEquals('delete' in (capabilities.sessionCapabilities as Record<string, unknown>), false);

    const listed = first.find((message) => message.id === 11)!.result as {
      sessions: Array<{ sessionId: string; cwd: string; title: string }>;
    };
    assertEquals(listed.sessions.length, 1);
    assertEquals(listed.sessions[0].cwd, await realpath(workspacePath));
    assertEquals(listed.sessions[0].title, 'Alpha-created acceptance');
    assertNotEquals(listed.sessions[0].sessionId, thread.acpSessionId);
    const zedSessionId = listed.sessions[0].sessionId;

    const loaded = await exchange(gateway.path, workspacePath, [
      request(20, 'initialize', { protocolVersion: 1, clientCapabilities: {} }),
      request(21, 'session/load', { sessionId: zedSessionId, cwd: workspacePath, mcpServers: [] }),
      request(22, 'session/prompt', {
        sessionId: zedSessionId,
        prompt: [{ type: 'text', text: 'FROM_ZED' }],
      }),
    ]);
    assert(loaded.some((message) => JSON.stringify(message).includes('FROM_ALPHA')));
    assert(loaded.some((message) => JSON.stringify(message).includes('FAKE_AGENT:FROM_ALPHA')));
    assert(loaded.some((message) => JSON.stringify(message).includes('FAKE_AGENT:FROM_ZED')));
    for (const message of loaded.filter((message) => message.method === 'session/update')) {
      assertEquals((message.params as { sessionId: string }).sessionId, zedSessionId);
    }

    await gateway.close();
    await portal.close();
    portal = await Portal.open(config);
    gateway = await serveLocalAcpGateway(portal);

    const resumed = await exchange(gateway.path, workspacePath, [
      request(30, 'initialize', { protocolVersion: 1, clientCapabilities: {} }),
      request(31, 'session/list', {}),
      request(32, 'session/resume', { sessionId: zedSessionId, cwd: workspacePath, mcpServers: [] }),
      request(33, 'session/prompt', {
        sessionId: zedSessionId,
        prompt: [{ type: 'text', text: 'AFTER_RESTART' }],
      }),
    ]);
    const relisted = resumed.find((message) => message.id === 31)!.result as {
      sessions: Array<{ sessionId: string }>;
    };
    assertEquals(relisted.sessions[0].sessionId, zedSessionId);
    const resumeResponseIndex = resumed.findIndex((message) => message.id === 32);
    assert(resumeResponseIndex > 0);
    assertEquals(
      resumed.slice(0, resumeResponseIndex).some((message) => message.method === 'session/update'),
      false,
    );
    assert(
      resumed.some((message) =>
        message.method === 'session/update' && JSON.stringify(message).includes('AFTER_RESTART')
      ),
    );
  } finally {
    await gateway.close();
    await portal.close();
    await removePath(root, { recursive: true });
  }
});

test('Zed-facing session identity scopes the same raw Thread ID by Portal Host', () => {
  const first = localAcpInternals.externalSessionId('host-a', 'same-thread');
  const second = localAcpInternals.externalSessionId('host-b', 'same-thread');
  assertNotEquals(first, second);
  assertEquals(localAcpInternals.threadIdFromExternalSession('host-a', first), 'same-thread');
  assertStringIncludes(first, 'weave-v1:');
});

test('Agent title updates persist in Portal and appear in Zed session listing after restart', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-product-agent-title-' });
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath);
  const fakeAgent = join(dirname(fileURLToPath(import.meta.url)), 'test-fixtures', 'fake-agent.ts');
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    displayName: 'Agent Title Portal',
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    executionContexts: [{ executionContextId: 'workspace', name: 'Workspace', path: workspacePath }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: process.execPath,
      args: [fakeAgent],
      env: {},
    }],
  };

  let portal = await Portal.open(config);
  let gateway = await serveLocalAcpGateway(portal);
  try {
    const context = await portal.resolveLocalAcpContext({ agentId: 'fake', workspacePath });
    const thread = await portal.createLocalAcpThread(context, 'Original title');
    const responses: JsonRpcMessage[] = [];
    let promptResolve: (() => void) | undefined;
    const promptComplete = new Promise<void>((resolve) => promptResolve = resolve);
    const attachment = await portal.connectLocalAcpThread(context, thread.threadId, (message) => {
      responses.push(message);
      if (message.id === 3 && message.method === undefined) promptResolve?.();
    });
    await attachment.receive(request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} }));
    await attachment.receive(request(2, 'session/load', {
      sessionId: thread.acpSessionId,
      cwd: workspacePath,
      mcpServers: [],
    }));
    await attachment.receive(request(3, 'session/prompt', {
      sessionId: thread.acpSessionId,
      prompt: [{ type: 'text', text: 'RENAME_TO:Agent-selected title' }],
    }));
    await promptComplete;
    attachment.close();

    assert(
      responses.some((message) =>
        message.method === 'session/update' &&
        (message.params as { update?: { sessionUpdate?: string; title?: string } }).update?.sessionUpdate ===
          'session_info_update' &&
        (message.params as { update?: { title?: string } }).update?.title === 'Agent-selected title'
      ),
    );
    assertEquals(
      portal.listLocalAcpThreads(context).find(({ threadId }) => threadId === thread.threadId)?.title,
      'Agent-selected title',
    );

    const prompt = async (id: number, text: string) => {
      let resolvePrompt: (() => void) | undefined;
      const completed = new Promise<void>((resolve) => resolvePrompt = resolve);
      const nextAttachment = await portal.connectLocalAcpThread(context, thread.threadId, (message) => {
        if (message.id === id && message.method === undefined) resolvePrompt?.();
      });
      await nextAttachment.receive(request(id, 'session/prompt', {
        sessionId: thread.acpSessionId,
        prompt: [{ type: 'text', text }],
      }));
      await completed;
      nextAttachment.close();
    };
    await prompt(4, 'CLEAR_TITLE');
    assertEquals(
      portal.listLocalAcpThreads(context).find(({ threadId }) => threadId === thread.threadId)?.title,
      undefined,
    );
    await prompt(5, 'RENAME_WRONG_SESSION_TO:Must be ignored');
    assertEquals(
      portal.listLocalAcpThreads(context).find(({ threadId }) => threadId === thread.threadId)?.title,
      undefined,
    );
    await prompt(6, 'RENAME_TO:Final persisted title');

    await gateway.close();
    await portal.close();
    portal = await Portal.open(config);
    gateway = await serveLocalAcpGateway(portal);

    const listed = await exchange(gateway.path, workspacePath, [
      request(7, 'initialize', { protocolVersion: 1, clientCapabilities: {} }),
      request(8, 'session/list', {}),
    ]);
    const sessions = (listed.find((message) => message.id === 8)?.result as {
      sessions: Array<{ title: string }>;
    }).sessions;
    assertEquals(sessions[0]?.title, 'Final persisted title');
  } finally {
    await gateway.close();
    await portal.close();
    await removePath(root, { recursive: true });
  }
});

test('Zed-facing load follows a provider session replaced during empty Thread recovery', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-product-zed-replacement-' });
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath);
  const fakeAgent = join(dirname(fileURLToPath(import.meta.url)), 'test-fixtures', 'fake-agent.ts');
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    displayName: 'Zed Replacement Portal',
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    executionContexts: [{ executionContextId: 'workspace', name: 'Workspace', path: workspacePath }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: process.execPath,
      args: [fakeAgent],
      env: {},
    }],
  };

  let portal = await Portal.open(config);
  let gateway = await serveLocalAcpGateway(portal);
  try {
    const context = await portal.resolveLocalAcpContext({ agentId: 'fake', workspacePath });
    const created = await portal.createLocalAcpThread(context, 'Empty recovery');
    await gateway.close();
    await portal.close();

    config.agents[0].args.push('--recovery=missing-session');
    portal = await Portal.open(config);
    gateway = await serveLocalAcpGateway(portal);

    const listed = await exchange(gateway.path, workspacePath, [
      request(40, 'initialize', { protocolVersion: 1, clientCapabilities: {} }),
      request(41, 'session/list', {}),
    ]);
    const sessionId = (listed.find((message) => message.id === 41)!.result as {
      sessions: Array<{ sessionId: string }>;
    }).sessions[0].sessionId;
    const loaded = await exchange(gateway.path, workspacePath, [
      request(42, 'initialize', { protocolVersion: 1, clientCapabilities: {} }),
      request(43, 'session/load', { sessionId, cwd: workspacePath, mcpServers: [] }),
    ]);

    assertEquals(loaded.find((message) => message.id === 43)?.error, undefined);
    assertEquals(
      portal.listLocalAcpThreads(context).find((thread) => thread.threadId === created.threadId)?.acpSessionId,
      'replacement-session',
    );
  } finally {
    await gateway.close();
    await portal.close();
    await removePath(root, { recursive: true });
  }
});

test('stdio ACP connector exits when the Portal gateway closes', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-product-zed-disconnect-' });
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath);
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    displayName: 'Zed Disconnect Portal',
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    executionContexts: [{ executionContextId: 'workspace', name: 'Workspace', path: workspacePath }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: process.execPath,
      args: ['eval', ''],
      env: {},
    }],
  };
  const portal = await Portal.open(config);
  const gateway = await serveLocalAcpGateway(portal);
  const input = new TransformStream<Uint8Array>();
  const output = new TransformStream<Uint8Array>();
  const inputWriter = input.writable.getWriter();
  const outputReader = output.readable.getReader();
  try {
    const connector = runStdioAcpConnector({
      path: gateway.path,
      agentId: 'fake',
      workspacePath,
      stdin: input.readable,
      stdout: output.writable,
    });
    await inputWriter.write(encoder.encode(`${JSON.stringify(request(50, 'initialize', {}))}\n`));
    const initialized = await outputReader.read();
    assertEquals(initialized.done, false);

    await gateway.close();
    await Promise.race([
      connector,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Connector did not exit after gateway shutdown.')), 1_000)
      ),
    ]);
  } finally {
    await inputWriter.close().catch(() => undefined);
    outputReader.releaseLock();
    await gateway.close();
    await portal.close();
    await removePath(root, { recursive: true });
  }
});
