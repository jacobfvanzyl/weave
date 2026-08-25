import { WORKSPACE_FILE_WATCH_EVENT_METHOD } from '@weave/product-protocol';
import { assertEquals, assertRejects } from 'jsr:@std/assert@1.0.14';
import { dirname, fromFileUrl, join } from 'jsr:@std/path@1.1.2';
import type { PortalConfig } from './config.ts';
import { Portal } from './portal.ts';
import { startPortalServer } from './server.ts';
import { RpcResponseError, RpcSocket, waitFor } from '../scripts/rpc-client.ts';

Deno.test('Alpha-facing Portal creates and prompts an ACP Thread over the product protocol', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-product-portal-' });
  const workspacePath = join(root, 'workspace');
  await Deno.mkdir(workspacePath);
  const fakeAgent = join(dirname(fromFileUrl(import.meta.url)), 'test-fixtures', 'fake-agent.ts');
  const token = 'acceptance-token';
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    accessToken: token,
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    workspaces: [{ workspaceId: 'workspace', name: 'Workspace', path: workspacePath }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: Deno.execPath(),
      args: ['run', '--quiet', '--allow-read', fakeAgent],
      env: {},
    }],
  };
  const portal = await Portal.open(config);
  const server = startPortalServer(portal);
  const address = server.addr as Deno.NetAddr;
  const baseUrl = `ws://127.0.0.1:${address.port}`;
  try {
    const rpc = await RpcSocket.open(`${baseUrl}/rpc`, token);
    const capabilities = await rpc.request('portal.capabilities') as { capabilities: string[] };
    assertEquals(capabilities.capabilities.includes('thread.create'), true);

    const created = await rpc.request('thread.create', { workspaceId: 'workspace', agentId: 'fake' }) as {
      thread: { threadId: string; acpSessionId: string };
    };
    assertEquals(created.thread.acpSessionId, 'fake-session');
    const listed = await rpc.request('thread.list') as { threads: Array<{ threadId: string }> };
    assertEquals(listed.threads.map((thread) => thread.threadId), [created.thread.threadId]);

    const attached = await rpc.request('thread.attach', { threadId: created.thread.threadId }) as {
      connection: { path: string; threadId: string };
    };
    const acp = await RpcSocket.open(
      `${baseUrl}${attached.connection.path}?threadId=${attached.connection.threadId}`,
      token,
    );
    await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const loaded = await acp.request('session/load', {
      sessionId: 'fake-session',
      cwd: workspacePath,
      mcpServers: [],
    });
    assertEquals(loaded, {
      modes: {
        currentModeId: 'ask',
        availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }],
      },
      configOptions: [{
        type: 'boolean',
        id: 'fast',
        name: 'Fast mode',
        currentValue: false,
      }],
    });
    const mode = await acp.request('session/set_mode', {
      sessionId: 'fake-session',
      modeId: 'code',
    });
    assertEquals(mode, {});
    assertEquals(
      acp.notifications.filter((message) => JSON.stringify(message).includes('current_mode_update')).length,
      1,
    );
    const configured = await acp.request('session/set_config_option', {
      sessionId: 'fake-session',
      configId: 'fast',
      type: 'boolean',
      value: true,
    });
    assertEquals(configured, {
      configOptions: [{
        type: 'boolean',
        id: 'fast',
        name: 'Fast mode',
        currentValue: true,
      }],
    });
    const observer = await RpcSocket.open(
      `${baseUrl}${attached.connection.path}?threadId=${attached.connection.threadId}`,
      token,
    );
    await observer.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    assertEquals(
      await observer.request('session/load', {
        sessionId: 'fake-session',
        cwd: workspacePath,
        mcpServers: [],
      }),
      {
        modes: {
          currentModeId: 'code',
          availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }],
        },
        configOptions: [{
          type: 'boolean',
          id: 'fast',
          name: 'Fast mode',
          currentValue: true,
        }],
      },
    );
    const prompting = acp.request('session/prompt', {
      sessionId: 'fake-session',
      prompt: [{ type: 'text', text: 'SLOW' }],
    });
    await assertRejects(
      () =>
        observer.request('session/prompt', {
          sessionId: 'fake-session',
          prompt: [{ type: 'text', text: 'CONFLICT' }],
        }),
      Error,
      'Another prompt is already active.',
    );
    await prompting;
    await waitFor(() =>
      [acp, observer].every((client) =>
        client.notifications.some((message) => JSON.stringify(message).includes('FAKE_AGENT:SLOW'))
      )
    );
    assertEquals(
      acp.notifications.filter((message) =>
        JSON.stringify(message).includes('user_message_chunk') &&
        JSON.stringify(message).includes('SLOW')
      ).length,
      0,
    );
    assertEquals(
      observer.notifications.filter((message) =>
        JSON.stringify(message).includes('user_message_chunk') &&
        JSON.stringify(message).includes('SLOW')
      ).length,
      1,
    );
    observer.close();
    acp.close();

    const reattached = await RpcSocket.open(
      `${baseUrl}${attached.connection.path}?threadId=${attached.connection.threadId}`,
      token,
    );
    await reattached.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await reattached.request('session/load', {
      sessionId: 'fake-session',
      cwd: workspacePath,
      mcpServers: [],
    });
    assertEquals(
      reattached.notifications.map((message) => JSON.stringify(message)).filter((message) => message.includes('SLOW'))
        .map((message) => message.includes('user_message_chunk') ? 'user' : 'agent'),
      ['user', 'agent'],
    );
    reattached.close();
    rpc.close();
  } finally {
    await server.shutdown();
    await portal.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Portal replays durable Thread events after a daemon restart', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-product-portal-restart-' });
  const workspacePath = join(root, 'workspace');
  await Deno.mkdir(workspacePath);
  const fakeAgent = join(dirname(fromFileUrl(import.meta.url)), 'test-fixtures', 'fake-agent.ts');
  const token = 'restart-token';
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    accessToken: token,
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    workspaces: [{ workspaceId: 'workspace', name: 'Workspace', path: workspacePath }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: Deno.execPath(),
      args: ['run', '--quiet', '--allow-read', fakeAgent],
      env: {},
    }],
  };

  let threadId = '';
  const firstPortal = await Portal.open(config);
  const firstServer = startPortalServer(firstPortal);
  const firstAddress = firstServer.addr as Deno.NetAddr;
  try {
    const rpc = await RpcSocket.open(`ws://127.0.0.1:${firstAddress.port}/rpc`, token);
    const created = await rpc.request('thread.create', { workspaceId: 'workspace', agentId: 'fake' }) as {
      thread: { threadId: string; acpSessionId: string };
    };
    threadId = created.thread.threadId;
    const attached = await rpc.request('thread.attach', { threadId }) as {
      connection: { path: string; threadId: string };
    };
    const acp = await RpcSocket.open(
      `ws://127.0.0.1:${firstAddress.port}${attached.connection.path}?threadId=${threadId}`,
      token,
    );
    await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await acp.request('session/load', { sessionId: 'fake-session', cwd: workspacePath, mcpServers: [] });
    await acp.request('session/prompt', {
      sessionId: 'fake-session',
      prompt: [{ type: 'text', text: 'BEFORE_RESTART' }],
    });
    await waitFor(() =>
      acp.notifications.some((message) => JSON.stringify(message).includes('FAKE_AGENT:BEFORE_RESTART'))
    );
    acp.close();
    rpc.close();
  } finally {
    await firstServer.shutdown();
    await firstPortal.close();
  }

  const secondPortal = await Portal.open(config);
  const secondServer = startPortalServer(secondPortal);
  const secondAddress = secondServer.addr as Deno.NetAddr;
  try {
    const rpc = await RpcSocket.open(`ws://127.0.0.1:${secondAddress.port}/rpc`, token);
    const attached = await rpc.request('thread.attach', { threadId }) as {
      connection: { path: string; threadId: string };
    };
    const acp = await RpcSocket.open(
      `ws://127.0.0.1:${secondAddress.port}${attached.connection.path}?threadId=${threadId}`,
      token,
    );
    await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await acp.request('session/load', { sessionId: 'fake-session', cwd: workspacePath, mcpServers: [] });
    assertEquals(
      acp.notifications
        .map((message) => JSON.stringify(message))
        .filter((message) => message.includes('BEFORE_RESTART'))
        .map((message) => message.includes('user_message_chunk') ? 'user' : 'agent'),
      ['user', 'agent'],
    );
    acp.close();
    rpc.close();
  } finally {
    await secondServer.shutdown();
    await secondPortal.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Portal gives opted-in clients stable cursor replay without changing ordinary ACP replay', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-product-portal-cursor-' });
  const workspacePath = join(root, 'workspace');
  await Deno.mkdir(workspacePath);
  const fakeAgent = join(dirname(fromFileUrl(import.meta.url)), 'test-fixtures', 'fake-agent.ts');
  const token = 'cursor-token';
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    accessToken: token,
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    workspaces: [{ workspaceId: 'workspace', name: 'Workspace', path: workspacePath }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: Deno.execPath(),
      args: ['run', '--quiet', '--allow-read', fakeAgent],
      env: {},
    }],
  };
  const portal = await Portal.open(config);
  const server = startPortalServer(portal);
  const address = server.addr as Deno.NetAddr;
  const baseUrl = `ws://127.0.0.1:${address.port}`;
  try {
    const rpc = await RpcSocket.open(`${baseUrl}/rpc`, token);
    const created = await rpc.request('thread.create', { workspaceId: 'workspace', agentId: 'fake' }) as {
      thread: { threadId: string };
    };
    const attached = await rpc.request('thread.attach', { threadId: created.thread.threadId }) as {
      connection: { path: string; threadId: string };
    };
    const acpUrl = `${baseUrl}${attached.connection.path}?threadId=${attached.connection.threadId}`;

    const author = await RpcSocket.open(acpUrl, token);
    await author.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await author.request('session/load', { sessionId: 'fake-session', cwd: workspacePath, mcpServers: [] });
    await author.request('session/prompt', {
      sessionId: 'fake-session',
      prompt: [{ type: 'text', text: 'FIRST_CURSOR_TURN' }],
    });

    const native = await RpcSocket.open(acpUrl, token);
    const initialized = await native.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    }) as { agentCapabilities: { _meta: Record<string, unknown> } };
    assertEquals(initialized.agentCapabilities._meta['weave.dev'], {
      threadEvents: {
        version: 1,
        ackMethod: '_weave.dev/thread_events/ack',
        syncNotification: '_weave.dev/thread_events/sync',
      },
      runtimeRecovery: {
        version: 1,
        stateNotification: '_weave.dev/runtime/state',
      },
    });
    await native.request('session/load', {
      sessionId: 'fake-session',
      cwd: workspacePath,
      mcpServers: [],
      _meta: { 'weave.dev/threadEvents': { afterSequence: 0 } },
    });
    const firstReplay = native.notifications.filter((message) => message.method === 'session/update');
    assertEquals(firstReplay.length, 2);
    assertEquals(
      firstReplay.map((message) =>
        (message.params as { update: { _meta: Record<string, unknown> } }).update._meta['weave.dev/threadEvent']
      ),
      [
        {
          sequence: 1,
          eventId: (firstReplay[0].params as { update: { _meta: Record<string, { eventId: string }> } }).update
            ._meta['weave.dev/threadEvent'].eventId,
          createdAt: (firstReplay[0].params as { update: { _meta: Record<string, { createdAt: string }> } }).update
            ._meta['weave.dev/threadEvent'].createdAt,
        },
        {
          sequence: 2,
          eventId: (firstReplay[1].params as { update: { _meta: Record<string, { eventId: string }> } }).update
            ._meta['weave.dev/threadEvent'].eventId,
          createdAt: (firstReplay[1].params as { update: { _meta: Record<string, { createdAt: string }> } }).update
            ._meta['weave.dev/threadEvent'].createdAt,
        },
      ],
    );
    const firstSync = native.notifications.find((message) => message.method === '_weave.dev/thread_events/sync');
    assertEquals(firstSync?.params, { sessionId: 'fake-session', lastSequence: 2, fullReload: false });
    native.notifications.splice(0);

    await author.request('session/prompt', {
      sessionId: 'fake-session',
      prompt: [{ type: 'text', text: 'SECOND_CURSOR_TURN' }],
    });
    await waitFor(() => native.notifications.filter((message) => message.method === 'session/update').length === 2);
    const liveSecondTurn = native.notifications.filter((message) => message.method === 'session/update');
    const liveMetadata = liveSecondTurn.map((message) =>
      (message.params as { update: { _meta: Record<string, unknown> } }).update._meta['weave.dev/threadEvent']
    );
    assertEquals(liveMetadata.map((value) => (value as { sequence: number }).sequence), [3, 4]);
    native.close();

    const resumed = await RpcSocket.open(acpUrl, token);
    await resumed.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await resumed.request('session/load', {
      sessionId: 'fake-session',
      cwd: workspacePath,
      mcpServers: [],
      _meta: { 'weave.dev/threadEvents': { afterSequence: 2 } },
    });
    const resumedUpdates = resumed.notifications.filter((message) => message.method === 'session/update');
    assertEquals(resumedUpdates.length, 2);
    assertEquals(
      resumedUpdates.map((message) =>
        (message.params as { update: { _meta: Record<string, unknown> } }).update._meta['weave.dev/threadEvent']
      ),
      liveMetadata,
    );
    assertEquals(
      resumed.notifications.find((message) => message.method === '_weave.dev/thread_events/sync')?.params,
      { sessionId: 'fake-session', lastSequence: 4, fullReload: false },
    );

    const ordinary = await RpcSocket.open(acpUrl, token);
    await ordinary.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await ordinary.request('session/load', { sessionId: 'fake-session', cwd: workspacePath, mcpServers: [] });
    const ordinaryUpdates = ordinary.notifications.filter((message) => message.method === 'session/update');
    assertEquals(ordinaryUpdates.length, 4);
    assertEquals(
      ordinaryUpdates.every((message) =>
        (message.params as { update: { _meta?: unknown } }).update._meta === undefined
      ),
      true,
    );
    assertEquals(
      ordinary.notifications.some((message) => message.method === '_weave.dev/thread_events/sync'),
      false,
    );

    ordinary.close();
    resumed.close();
    author.close();
    rpc.close();
  } finally {
    await server.shutdown();
    await portal.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Portal persists bounded replay gaps and enforces monotonic acknowledgements', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-product-portal-retention-' });
  const workspacePath = join(root, 'workspace');
  await Deno.mkdir(workspacePath);
  const fakeAgent = join(dirname(fromFileUrl(import.meta.url)), 'test-fixtures', 'fake-agent.ts');
  const token = 'retention-token';
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    accessToken: token,
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    threadEventRetentionLimit: 2,
    workspaces: [{ workspaceId: 'workspace', name: 'Workspace', path: workspacePath }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: Deno.execPath(),
      args: ['run', '--quiet', '--allow-read', fakeAgent, '--replay-transcript'],
      env: {},
    }],
  };

  let threadId = '';
  const firstPortal = await Portal.open(config);
  const firstServer = startPortalServer(firstPortal);
  const firstAddress = firstServer.addr as Deno.NetAddr;
  try {
    const rpc = await RpcSocket.open(`ws://127.0.0.1:${firstAddress.port}/rpc`, token);
    const created = await rpc.request('thread.create', { workspaceId: 'workspace', agentId: 'fake' }) as {
      thread: { threadId: string };
    };
    threadId = created.thread.threadId;
    const attached = await rpc.request('thread.attach', { threadId }) as {
      connection: { path: string; threadId: string };
    };
    const acp = await RpcSocket.open(
      `ws://127.0.0.1:${firstAddress.port}${attached.connection.path}?threadId=${threadId}`,
      token,
    );
    await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await acp.request('session/load', { sessionId: 'fake-session', cwd: workspacePath, mcpServers: [] });
    for (const prompt of ['RETAINED_FIRST', 'RETAINED_SECOND']) {
      await acp.request('session/prompt', {
        sessionId: 'fake-session',
        prompt: [{ type: 'text', text: prompt }],
      });
    }
    const acpUrl = `ws://127.0.0.1:${firstAddress.port}${attached.connection.path}?threadId=${threadId}`;
    const ordinary = await RpcSocket.open(acpUrl, token);
    await ordinary.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await ordinary.request('session/load', { sessionId: 'fake-session', cwd: workspacePath, mcpServers: [] });
    assertEquals(ordinary.notifications.filter((message) => message.method === 'session/update').length, 4);

    const native = await RpcSocket.open(acpUrl, token);
    await native.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await native.request('session/load', {
      sessionId: 'fake-session',
      cwd: workspacePath,
      mcpServers: [],
      _meta: { 'weave.dev/threadEvents': { afterSequence: null } },
    });
    assertEquals(native.notifications.filter((message) => message.method === 'session/update').length, 4);
    assertEquals(
      native.notifications.find((message) => message.method === '_weave.dev/thread_events/sync')?.params,
      { sessionId: 'fake-session', lastSequence: 4, fullReload: true },
    );
    native.close();
    ordinary.close();
    acp.close();
    rpc.close();
  } finally {
    await firstServer.shutdown();
    await firstPortal.close();
  }

  const secondPortal = await Portal.open(config);
  const secondServer = startPortalServer(secondPortal);
  const secondAddress = secondServer.addr as Deno.NetAddr;
  try {
    const rpc = await RpcSocket.open(`ws://127.0.0.1:${secondAddress.port}/rpc`, token);
    const attached = await rpc.request('thread.attach', { threadId }) as {
      connection: { path: string; threadId: string };
    };
    const acpUrl = `ws://127.0.0.1:${secondAddress.port}${attached.connection.path}?threadId=${threadId}`;

    const stale = await RpcSocket.open(acpUrl, token);
    await stale.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    let gap: unknown;
    try {
      await stale.request('session/load', {
        sessionId: 'fake-session',
        cwd: workspacePath,
        mcpServers: [],
        _meta: { 'weave.dev/threadEvents': { afterSequence: 1 } },
      });
    } catch (cause) {
      gap = cause;
    }
    assertEquals(gap instanceof RpcResponseError && { code: gap.code, data: gap.data }, {
      code: -32060,
      data: { code: 'RESUME_GAP', compactedThrough: 2, lastSequence: 4, reloadAfterSequence: null },
    });
    stale.close();

    const resumed = await RpcSocket.open(acpUrl, token);
    await resumed.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await resumed.request('session/load', {
      sessionId: 'fake-session',
      cwd: workspacePath,
      mcpServers: [],
      _meta: { 'weave.dev/threadEvents': { afterSequence: 2 } },
    });
    assertEquals(
      resumed.notifications
        .filter((message) => message.method === 'session/update')
        .map((message) =>
          (message.params as { update: { _meta: Record<string, { sequence: number }> } }).update._meta[
            'weave.dev/threadEvent'
          ].sequence
        ),
      [3, 4],
    );
    assertEquals(
      await resumed.request('_weave.dev/thread_events/ack', { sessionId: 'fake-session', sequence: 4 }),
      { acknowledgedSequence: 4 },
    );
    let regressed: unknown;
    try {
      await resumed.request('_weave.dev/thread_events/ack', { sessionId: 'fake-session', sequence: 3 });
    } catch (cause) {
      regressed = cause;
    }
    assertEquals(regressed instanceof RpcResponseError && regressed.code, -32060);

    resumed.close();
    rpc.close();
  } finally {
    await secondServer.shutdown();
    await secondPortal.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Portal recovers an uncertain prompt with durable fenced runtime generations', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-product-portal-recovery-' });
  const workspacePath = join(root, 'workspace');
  await Deno.mkdir(workspacePath);
  const fakeAgent = join(dirname(fromFileUrl(import.meta.url)), 'test-fixtures', 'fake-agent.ts');
  const token = 'recovery-token';
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    accessToken: token,
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    workspaces: [{ workspaceId: 'workspace', name: 'Workspace', path: workspacePath }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: Deno.execPath(),
      args: ['run', '--quiet', '--allow-read', '--allow-run', fakeAgent, '--recovery=resume-fails-then-load'],
      env: {},
    }],
  };

  let threadId = '';
  const firstPortal = await Portal.open(config);
  const firstServer = startPortalServer(firstPortal);
  const firstAddress = firstServer.addr as Deno.NetAddr;
  try {
    const rpc = await RpcSocket.open(`ws://127.0.0.1:${firstAddress.port}/rpc`, token);
    const created = await rpc.request('thread.create', { workspaceId: 'workspace', agentId: 'fake' }) as {
      thread: { threadId: string };
    };
    threadId = created.thread.threadId;
    const attached = await rpc.request('thread.attach', { threadId }) as {
      connection: { path: string; threadId: string };
    };
    const acp = await RpcSocket.open(
      `ws://127.0.0.1:${firstAddress.port}${attached.connection.path}?threadId=${threadId}`,
      token,
    );
    const initialized = await acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    }) as { agentCapabilities: { _meta: Record<string, { runtimeRecovery: unknown }> } };
    assertEquals(initialized.agentCapabilities._meta['weave.dev'].runtimeRecovery, {
      version: 1,
      stateNotification: '_weave.dev/runtime/state',
    });
    await acp.request('session/load', {
      sessionId: 'fake-session',
      cwd: workspacePath,
      mcpServers: [],
      _meta: { 'weave.dev/threadEvents': { afterSequence: 0 } },
    });
    assertEquals(
      acp.notifications.some((message) => JSON.stringify(message).includes('PROVIDER_REPLAY_SHOULD_NOT_ESCAPE')),
      false,
    );

    let uncertain: unknown;
    try {
      await acp.request('session/prompt', {
        sessionId: 'fake-session',
        prompt: [{ type: 'text', text: 'CRASH_WITH_STALE_OUTPUT' }],
      });
    } catch (cause) {
      uncertain = cause;
    }
    assertEquals(uncertain instanceof RpcResponseError && { code: uncertain.code, data: uncertain.data }, {
      code: -32050,
      data: { code: 'PROMPT_UNCERTAIN', generation: 1 },
    });
    await waitFor(() =>
      acp.notifications.filter((message) => message.method === '_weave.dev/runtime/state').length === 3
    );
    assertEquals(
      acp.notifications
        .filter((message) => message.method === '_weave.dev/runtime/state')
        .map((message) => {
          const params = message.params as { generation: number; state: string; code: string };
          return { generation: params.generation, state: params.state, code: params.code };
        }),
      [
        { generation: 1, state: 'uncertain', code: 'PROMPT_UNCERTAIN' },
        { generation: 2, state: 'restoring', code: 'RESTORING' },
        { generation: 2, state: 'idle', code: 'RECOVERED' },
      ],
    );
    assertEquals(
      acp.notifications.some((message) => JSON.stringify(message).includes('PROVIDER_REPLAY_SHOULD_NOT_ESCAPE')),
      false,
    );
    await new Promise((resolve) => setTimeout(resolve, 125));
    assertEquals(
      acp.notifications.some((message) => JSON.stringify(message).includes('OBSOLETE_PROVIDER_EVENT')),
      false,
    );
    await acp.request('session/prompt', {
      sessionId: 'fake-session',
      prompt: [{ type: 'text', text: 'AFTER_RECOVERY' }],
    });
    await waitFor(() =>
      acp.notifications.some((message) =>
        JSON.stringify(message).includes('FAKE_AGENT_LOAD_AFTER_RESUME:AFTER_RECOVERY')
      )
    );
    acp.close();
    rpc.close();
  } finally {
    await firstServer.shutdown();
    await firstPortal.close();
  }

  const secondPortal = await Portal.open(config);
  const secondServer = startPortalServer(secondPortal);
  const secondAddress = secondServer.addr as Deno.NetAddr;
  try {
    const rpc = await RpcSocket.open(`ws://127.0.0.1:${secondAddress.port}/rpc`, token);
    const attached = await rpc.request('thread.attach', { threadId }) as {
      connection: { path: string; threadId: string };
    };
    const acp = await RpcSocket.open(
      `ws://127.0.0.1:${secondAddress.port}${attached.connection.path}?threadId=${threadId}`,
      token,
    );
    await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await acp.request('session/load', {
      sessionId: 'fake-session',
      cwd: workspacePath,
      mcpServers: [],
      _meta: { 'weave.dev/threadEvents': { afterSequence: 0 } },
    });
    assertEquals(
      acp.notifications.some((message) => JSON.stringify(message).includes('PROVIDER_REPLAY_SHOULD_NOT_ESCAPE')),
      false,
    );
    let uncertain: unknown;
    try {
      await acp.request('session/prompt', {
        sessionId: 'fake-session',
        prompt: [{ type: 'text', text: 'CRASH_AFTER_RESTART' }],
      });
    } catch (cause) {
      uncertain = cause;
    }
    assertEquals(
      uncertain instanceof RpcResponseError && (uncertain.data as { generation?: unknown }).generation,
      3,
    );
    await waitFor(() =>
      acp.notifications.some((message) =>
        message.method === '_weave.dev/runtime/state' &&
        (message.params as { generation?: unknown; code?: unknown }).generation === 4 &&
        (message.params as { generation?: unknown; code?: unknown }).code === 'RECOVERED'
      )
    );
    acp.close();
    rpc.close();
  } finally {
    await secondServer.shutdown();
    await secondPortal.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Portal exposes an explicit unavailable state when an Agent cannot resume', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-product-portal-cannot-resume-' });
  const workspacePath = join(root, 'workspace');
  await Deno.mkdir(workspacePath);
  const fakeAgent = join(dirname(fromFileUrl(import.meta.url)), 'test-fixtures', 'fake-agent.ts');
  const token = 'cannot-resume-token';
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    accessToken: token,
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    workspaces: [{ workspaceId: 'workspace', name: 'Workspace', path: workspacePath }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: Deno.execPath(),
      args: ['run', '--quiet', '--allow-read', fakeAgent, '--recovery=none'],
      env: {},
    }],
  };
  const portal = await Portal.open(config);
  const server = startPortalServer(portal);
  const address = server.addr as Deno.NetAddr;
  try {
    const rpc = await RpcSocket.open(`ws://127.0.0.1:${address.port}/rpc`, token);
    const created = await rpc.request('thread.create', { workspaceId: 'workspace', agentId: 'fake' }) as {
      thread: { threadId: string };
    };
    const attached = await rpc.request('thread.attach', { threadId: created.thread.threadId }) as {
      connection: { path: string; threadId: string };
    };
    const acp = await RpcSocket.open(
      `ws://127.0.0.1:${address.port}${attached.connection.path}?threadId=${attached.connection.threadId}`,
      token,
    );
    await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await acp.request('session/load', {
      sessionId: 'fake-session',
      cwd: workspacePath,
      mcpServers: [],
      _meta: { 'weave.dev/threadEvents': { afterSequence: 0 } },
    });
    try {
      await acp.request('session/prompt', {
        sessionId: 'fake-session',
        prompt: [{ type: 'text', text: 'CRASH_AFTER_NO_RECOVERY' }],
      });
    } catch {
      // The explicit runtime state below is the contract under test.
    }
    await waitFor(() =>
      acp.notifications.some((message) =>
        message.method === '_weave.dev/runtime/state' &&
        (message.params as { code?: unknown }).code === 'CANNOT_RESUME'
      )
    );
    assertEquals(
      acp.notifications
        .filter((message) => message.method === '_weave.dev/runtime/state')
        .map((message) => {
          const params = message.params as { generation: number; state: string; code: string };
          return { generation: params.generation, state: params.state, code: params.code };
        }),
      [
        { generation: 1, state: 'uncertain', code: 'PROMPT_UNCERTAIN' },
        { generation: 2, state: 'restoring', code: 'RESTORING' },
        { generation: 2, state: 'unavailable', code: 'CANNOT_RESUME' },
      ],
    );
    let unavailable: unknown;
    try {
      await acp.request('session/prompt', {
        sessionId: 'fake-session',
        prompt: [{ type: 'text', text: 'MUST_NOT_RUN' }],
      });
    } catch (cause) {
      unavailable = cause;
    }
    assertEquals(unavailable instanceof RpcResponseError && { code: unavailable.code, data: unavailable.data }, {
      code: -32050,
      data: { code: 'CANNOT_RESUME', generation: 2 },
    });

    acp.close();
    rpc.close();
  } finally {
    await server.shutdown();
    await portal.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Portal rejects an invalid access token before exposing metadata', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-product-portal-auth-' });
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    accessToken: 'correct',
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    workspaces: [{ workspaceId: 'workspace', name: 'Workspace', path: root }],
    agents: [{ agentId: 'fake', name: 'Fake', command: 'false', args: [], env: {} }],
  };
  const portal = await Portal.open(config);
  const server = startPortalServer(portal);
  const address = server.addr as Deno.NetAddr;
  try {
    await assertRejects(() => RpcSocket.open(`ws://127.0.0.1:${address.port}/rpc`, 'incorrect'));
  } finally {
    await server.shutdown();
    await portal.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Alpha-facing Portal exposes typed Workspace file operations and connection-scoped changes', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-product-files-rpc-' });
  const workspacePath = join(root, 'workspace');
  await Deno.mkdir(workspacePath);
  await Deno.writeTextFile(join(workspacePath, 'README.md'), '# WVE-42\n');
  const token = 'filesystem-token';
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    accessToken: token,
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    workspaces: [{ workspaceId: 'workspace', name: 'Workspace', path: workspacePath }],
    agents: [{ agentId: 'fake', name: 'Fake', command: 'false', args: [], env: {} }],
  };
  const portal = await Portal.open(config);
  const server = startPortalServer(portal);
  const address = server.addr as Deno.NetAddr;
  const rpc = await RpcSocket.open(`ws://127.0.0.1:${address.port}/rpc`, token);
  try {
    const capabilities = await rpc.request('portal.capabilities') as { capabilities: string[] };
    assertEquals(capabilities.capabilities.includes('workspace.file.read'), true);

    const listed = await rpc.request('workspace.file.list', { workspaceId: 'workspace', path: '' }) as {
      entries: Array<{ path: string }>;
    };
    assertEquals(listed.entries.map((entry) => entry.path), ['README.md']);
    const read = await rpc.request('workspace.file.read', { workspaceId: 'workspace', path: 'README.md' }) as {
      content: string;
      contentHash: string;
    };
    assertEquals(read.content, '# WVE-42\n');

    let stale: unknown;
    try {
      await rpc.request('workspace.file.write', {
        workspaceId: 'workspace',
        path: 'README.md',
        content: 'stale',
        expectedContentHash: '0'.repeat(64),
      });
    } catch (cause) {
      stale = cause;
    }
    assertEquals(stale instanceof RpcResponseError && { code: stale.code, data: stale.data }, {
      code: -32010,
      data: {
        domain: 'workspace-filesystem',
        code: 'STALE_CONTENT',
        path: 'README.md',
        expectedContentHash: '0'.repeat(64),
        actualContentHash: read.contentHash,
      },
    });

    await rpc.request('workspace.directory.create', { workspaceId: 'workspace', path: 'non-empty' });
    await rpc.request('workspace.file.write', {
      workspaceId: 'workspace',
      path: 'non-empty/file.txt',
      content: 'content',
      expectedContentHash: null,
    });
    let nonEmpty: unknown;
    try {
      await rpc.request('workspace.file.delete', { workspaceId: 'workspace', path: 'non-empty' });
    } catch (cause) {
      nonEmpty = cause;
    }
    assertEquals(nonEmpty instanceof RpcResponseError && { code: nonEmpty.code, data: nonEmpty.data }, {
      code: -32010,
      data: { domain: 'workspace-filesystem', code: 'DIRECTORY_NOT_EMPTY', path: 'non-empty' },
    });
    assertEquals(JSON.stringify(nonEmpty).includes(workspacePath), false);

    const watch = await rpc.request('workspace.file.watch.start', { workspaceId: 'workspace', paths: [''] }) as {
      subscriptionId: string;
    };
    await rpc.request('workspace.file.write', {
      workspaceId: 'workspace',
      path: 'created.txt',
      content: 'created',
      expectedContentHash: null,
    });
    await waitFor(() =>
      rpc.notifications.some((message) =>
        message.method === WORKSPACE_FILE_WATCH_EVENT_METHOD && JSON.stringify(message.params).includes('created.txt')
      )
    );
    assertEquals(await rpc.request('workspace.file.watch.stop', { subscriptionId: watch.subscriptionId }), {
      ok: true,
    });
  } finally {
    rpc.close();
    await server.shutdown();
    await portal.close();
    await Deno.remove(root, { recursive: true });
  }
});
