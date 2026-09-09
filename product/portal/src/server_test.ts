import { fileURLToPath } from 'node:url';
import { test } from './test-support.ts';
import { mkdir, readText, readTextSync, realpath, removePath, symlink, temporaryDirectory, writeText } from './host-files.ts';
import {
  PORTAL_PAIR_REQUEST_TYPE,
  TERMINAL_EVENT_METHOD,
  WORKSPACE_FILE_WATCH_EVENT_METHOD,
  WORKSPACE_CONTEXT_CAPABILITY,
} from '@weave/product-protocol';
import { assertEquals, assertRejects } from './test-support.ts';
import { dirname, join } from 'node:path';
import type { PortalConfig } from './config.ts';
import { Portal } from './portal.ts';
import { sendTerminal, startPortalServer } from './server.ts';
import { InMemoryTerminalBackend } from './terminals.ts';
import {
  generatePortalKey,
  type PortalCredentialSigner,
  RpcResponseError,
  RpcSocket,
  waitFor,
} from '../scripts/rpc-client.ts';

const pairTestCredential = async (
  portal: Portal,
  label = 'Portal test client',
): Promise<PortalCredentialSigner> => {
  const key = await generatePortalKey();
  const token = await portal.security.createPairingToken();
  const paired = await portal.security.redeemPairing({
    type: PORTAL_PAIR_REQUEST_TYPE,
    token,
    label,
    publicKey: key.publicKey,
  });
  return { ...key, credentialId: paired.principal.credentialId };
};

test('Portal closes a backpressured Terminal socket with a retryable resync reason', () => {
  const closes: Array<{ code?: number; reason?: string }> = [];
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 256 * 1024,
    send: () => {
      throw new Error('backpressured socket must not send');
    },
    close: (code?: number, reason?: string) => closes.push({ code, reason }),
  };
  assertEquals(
    sendTerminal(socket, {
      jsonrpc: '2.0',
      method: 'terminal.event',
      params: {},
    }),
    false,
  );
  assertEquals(closes, [{
    code: 1013,
    reason: 'Terminal stream fell behind; reconnect to resync.',
  }]);
});

test('Portal RPC exposes persistent Terminal control and observer attachments', async () => {
  const root = await temporaryDirectory({
    prefix: 'weave-product-terminal-rpc-',
  });
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath);
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    displayName: 'Terminal Portal',
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    workspaces: [{
      workspaceId: 'workspace',
      name: 'Workspace',
      path: workspacePath,
    }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: 'false',
      args: [],
      env: {},
    }],
  };
  const backend = new InMemoryTerminalBackend();
  const portal = await Portal.open(config, { terminalBackend: backend });
  const credential = await pairTestCredential(portal);
  const server = startPortalServer(portal);
  const address = server.addr as { hostname: string; port: number };
  const url = `ws://127.0.0.1:${address.port}/rpc`;
  const controller = await RpcSocket.open(url, credential);
  const observer = await RpcSocket.open(url, credential);
  try {
    const capabilities = await controller.request('portal.capabilities') as {
      capabilities: string[];
    };
    assertEquals(capabilities.capabilities.includes('terminal.attach'), true);

    const created = await controller.request('terminal.create', {
      workspaceId: 'workspace',
      cols: 90,
      rows: 28,
    }) as { terminal: { terminalId: string } };
    const controlled = await controller.request('terminal.attach', {
      workspaceId: 'workspace',
      terminalId: created.terminal.terminalId,
      mode: 'control',
    }) as { attachment: { attachmentId: string } };

    let conflict: unknown;
    try {
      await observer.request('terminal.attach', {
        workspaceId: 'workspace',
        terminalId: created.terminal.terminalId,
        mode: 'control',
      });
    } catch (cause) {
      conflict = cause;
    }
    assertEquals(
      conflict instanceof RpcResponseError &&
        { code: conflict.code, data: conflict.data },
      {
        code: -32012,
        data: {
          domain: 'terminal',
          code: 'TERMINAL_CONTROLLED',
          workspaceId: 'workspace',
          terminalId: created.terminal.terminalId,
        },
      },
    );

    const observed = await observer.request('terminal.attach', {
      workspaceId: 'workspace',
      terminalId: created.terminal.terminalId,
      mode: 'observe',
    }) as { attachment: { attachmentId: string } };
    await backend.emitOutput(created.terminal.terminalId, 'ready\r\n');
    await waitFor(() =>
      [controller, observer].every((socket) =>
        socket.notifications.some((message) => message.method === TERMINAL_EVENT_METHOD)
      )
    );

    await controller.request('terminal.input', {
      workspaceId: 'workspace',
      terminalId: created.terminal.terminalId,
      attachmentId: controlled.attachment.attachmentId,
      data: 'echo ready\r',
    });
    assertEquals(backend.inputs.at(-1)?.data, 'echo ready\r');
    for (const data of ['\r', ' ', '\t']) {
      await controller.request('terminal.input', {
        workspaceId: 'workspace',
        terminalId: created.terminal.terminalId,
        attachmentId: controlled.attachment.attachmentId,
        data,
      });
    }
    assertEquals(backend.inputs.slice(-3).map(({ data }) => data), [
      '\r',
      ' ',
      '\t',
    ]);

    const restrictedKey = await generatePortalKey();
    const restrictedGrants = portal.security.defaultGrants();
    restrictedGrants.workspaceIds = [];
    const restrictedToken = await portal.security.createPairingToken(
      60_000,
      restrictedGrants,
    );
    const restrictedPairing = await portal.security.redeemPairing({
      type: PORTAL_PAIR_REQUEST_TYPE,
      token: restrictedToken,
      label: 'Restricted Terminal client',
      publicKey: restrictedKey.publicKey,
    });
    const restricted = await RpcSocket.open(url, {
      ...restrictedKey,
      credentialId: restrictedPairing.principal.credentialId,
    });
    const unauthorized = await assertRejects(
      () =>
        restricted.request('terminal.snapshot', {
          workspaceId: 'workspace',
          terminalId: created.terminal.terminalId,
        }),
      RpcResponseError,
      'Resource is unavailable.',
    );
    restricted.close();
    assertEquals({
      message: unauthorized.message,
      code: unauthorized.code,
      resourceCode: (unauthorized.data as { code?: string }).code,
    }, {
      message: 'Resource is unavailable.',
      code: -32003,
      resourceCode: 'RESOURCE_UNAVAILABLE',
    });

    controller.close();
    let replacement: { attachment: { attachmentId: string } } | undefined;
    for (let attempt = 0; attempt < 100 && !replacement; attempt += 1) {
      try {
        replacement = await observer.request('terminal.attach', {
          workspaceId: 'workspace',
          terminalId: created.terminal.terminalId,
          mode: 'control',
        }) as { attachment: { attachmentId: string } };
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assertEquals(
      replacement?.attachment.attachmentId.length ? true : false,
      true,
    );
    await observer.request('terminal.detach', {
      workspaceId: 'workspace',
      terminalId: created.terminal.terminalId,
      attachmentId: observed.attachment.attachmentId,
    });
  } finally {
    controller.close();
    observer.close();
    await server.shutdown();
    await portal.close();
    await removePath(root, { recursive: true });
  }
});

test('Alpha registers and removes a durable project through its chosen Portal', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-product-project-' });
  const projectPath = join(root, 'project');
  await mkdir(projectPath);
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    displayName: 'Project Portal',
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    workspaces: [],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: 'false',
      args: [],
      env: {},
    }],
  };
  let portal = await Portal.open(config);
  const credential = await pairTestCredential(portal);
  let server = startPortalServer(portal);
  try {
    let address = server.addr as { hostname: string; port: number };
    let rpc = await RpcSocket.open(
      `ws://127.0.0.1:${address.port}/rpc`,
      credential,
    );
    const added = await rpc.request('workspace.add', {
      path: projectPath,
      name: 'Project',
    }) as {
      workspace: { workspaceId: string; name: string; rootName: string };
    };
    assertEquals(added.workspace.name, 'Project');
    assertEquals(added.workspace.rootName, 'project');
    assertEquals(
      (await rpc.request('workspace.list') as {
        workspaces: Array<{ workspaceId: string }>;
      }).workspaces.map(({ workspaceId }) => workspaceId),
      [added.workspace.workspaceId],
    );
    rpc.close();
    await server.shutdown();
    await portal.close();

    portal = await Portal.open(config);
    server = startPortalServer(portal);
    address = server.addr as { hostname: string; port: number };
    rpc = await RpcSocket.open(
      `ws://127.0.0.1:${address.port}/rpc`,
      credential,
    );
    assertEquals(
      (await rpc.request('workspace.list') as {
        workspaces: Array<
          { workspaceId: string; name: string; rootName: string }
        >;
      }).workspaces,
      [{
        workspaceId: added.workspace.workspaceId,
        name: 'Project',
        rootName: 'project',
        canonicalPath: await realpath(projectPath),
      }],
    );

    assertEquals(
      await rpc.request('workspace.remove', {
        workspaceId: added.workspace.workspaceId,
      }),
      { removed: true },
    );
    assertEquals(
      (await rpc.request('workspace.list') as { workspaces: unknown[] })
        .workspaces,
      [],
    );
    rpc.close();
    await server.shutdown();
    await portal.close();

    portal = await Portal.open(config);
    server = startPortalServer(portal);
    address = server.addr as { hostname: string; port: number };
    rpc = await RpcSocket.open(
      `ws://127.0.0.1:${address.port}/rpc`,
      credential,
    );
    assertEquals(
      (await rpc.request('workspace.list') as { workspaces: unknown[] })
        .workspaces,
      [],
    );
    rpc.close();
  } finally {
    await server.shutdown().catch(() => undefined);
    await portal.close();
    await removePath(root, { recursive: true });
  }
});

test('Alpha-facing Portal creates and prompts an ACP Thread over the product protocol', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-product-portal-' });
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath);
  const fakeAgent = join(
    dirname(fileURLToPath(import.meta.url)),
    'test-fixtures',
    'fake-agent.ts',
  );
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    displayName: 'Test Portal',
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    workspaces: [{
      workspaceId: 'workspace',
      name: 'Workspace',
      path: workspacePath,
    }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: process.execPath,
      args: [fakeAgent],
      env: {},
    }],
  };
  const portal = await Portal.open(config);
  const credential = await pairTestCredential(portal);
  const server = startPortalServer(portal);
  const address = server.addr as { hostname: string; port: number };
  const baseUrl = `ws://127.0.0.1:${address.port}`;
  try {
    const rpc = await RpcSocket.open(`${baseUrl}/rpc`, credential);
    const capabilities = await rpc.request('portal.capabilities') as {
      capabilities: string[];
    };
    assertEquals(capabilities.capabilities.includes('thread.create'), true);

    const created = await rpc.request('thread.create', {
      workspaceId: 'workspace',
      agentId: 'fake',
    }) as {
      thread: { threadId: string; acpSessionId: string };
    };
    assertEquals(created.thread.acpSessionId, 'fake-session');
    const listed = await rpc.request('thread.list') as {
      threads: Array<{ threadId: string }>;
    };
    assertEquals(listed.threads.map((thread) => thread.threadId), [
      created.thread.threadId,
    ]);

    const attached = await rpc.request('thread.attach', {
      threadId: created.thread.threadId,
    }) as {
      connection: { path: string; threadId: string };
    };
    const acp = await RpcSocket.open(
      `${baseUrl}${attached.connection.path}?threadId=${attached.connection.threadId}`,
      credential,
    );
    await acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    const loaded = await acp.request('session/load', {
      sessionId: 'fake-session',
      cwd: workspacePath,
      mcpServers: [],
    });
    assertEquals(loaded, {
      modes: {
        currentModeId: 'ask',
        availableModes: [{ id: 'ask', name: 'Ask' }, {
          id: 'code',
          name: 'Code',
        }],
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
      credential,
    );
    await observer.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    assertEquals(
      await observer.request('session/load', {
        sessionId: 'fake-session',
        cwd: workspacePath,
        mcpServers: [],
      }),
      {
        modes: {
          currentModeId: 'code',
          availableModes: [{ id: 'ask', name: 'Ask' }, {
            id: 'code',
            name: 'Code',
          }],
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
      credential,
    );
    await reattached.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    await reattached.request('session/load', {
      sessionId: 'fake-session',
      cwd: workspacePath,
      mcpServers: [],
    });
    assertEquals(
      reattached.notifications.map((message) => JSON.stringify(message)).filter(
        (message) => message.includes('SLOW'),
      )
        .map((message) => message.includes('user_message_chunk') ? 'user' : 'agent'),
      ['user', 'agent'],
    );
    reattached.close();
    rpc.close();
  } finally {
    await server.shutdown();
    await portal.close();
    await removePath(root, { recursive: true });
  }
});

test('Portal preflights draft config without listing it and promotes the same session on first prompt', async () => {
  const root = await temporaryDirectory({
    prefix: 'weave-product-portal-draft-',
  });
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath);
  const fakeAgent = join(
    dirname(fileURLToPath(import.meta.url)),
    'test-fixtures',
    'fake-agent.ts',
  );
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    displayName: 'Draft Portal',
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    workspaces: [{
      workspaceId: 'workspace',
      name: 'Workspace',
      path: workspacePath,
    }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: process.execPath,
      args: [fakeAgent],
      env: {},
    }],
  };
  const portal = await Portal.open(config);
  const credential = await pairTestCredential(portal);
  const server = startPortalServer(portal);
  const address = server.addr as { hostname: string; port: number };
  const baseUrl = `ws://127.0.0.1:${address.port}`;
  try {
    const rpc = await RpcSocket.open(`${baseUrl}/rpc`, credential);
    const capabilities = await rpc.request('portal.capabilities') as {
      capabilities: string[];
    };
    assertEquals(capabilities.capabilities.includes('thread.draft'), true);

    const disposable = await rpc.request('thread.draft.create', {
      workspaceId: 'workspace',
      agentId: 'fake',
    }) as { thread: { threadId: string } };
    assertEquals(
      (await rpc.request('thread.list') as { threads: unknown[] }).threads,
      [],
    );
    await rpc.request('thread.draft.discard', {
      threadId: disposable.thread.threadId,
    });
    await assertRejects(
      () => rpc.request('thread.attach', { threadId: disposable.thread.threadId }),
      RpcResponseError,
      'Resource is unavailable.',
    );

    const prepared = await rpc.request('thread.draft.create', {
      workspaceId: 'workspace',
      agentId: 'fake',
    }) as { thread: { threadId: string; acpSessionId: string } };
    const attached = await rpc.request('thread.attach', {
      threadId: prepared.thread.threadId,
    }) as { connection: { path: string; threadId: string; cwd: string } };
    const acp = await RpcSocket.open(
      `${baseUrl}${attached.connection.path}?threadId=${attached.connection.threadId}`,
      credential,
    );
    await acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    const loaded = await acp.request('session/load', {
      sessionId: prepared.thread.acpSessionId,
      cwd: attached.connection.cwd,
      mcpServers: [],
    }) as { configOptions: unknown[] };
    assertEquals(loaded.configOptions, [{
      type: 'boolean',
      id: 'fast',
      name: 'Fast mode',
      currentValue: false,
    }]);
    await acp.request('session/set_config_option', {
      sessionId: prepared.thread.acpSessionId,
      configId: 'fast',
      type: 'boolean',
      value: true,
    });
    assertEquals(
      (await rpc.request('thread.list') as { threads: unknown[] }).threads,
      [],
    );

    await acp.request('session/prompt', {
      sessionId: prepared.thread.acpSessionId,
      prompt: [{ type: 'text', text: 'PROMOTE_DRAFT' }],
    });
    const listed = await rpc.request('thread.list') as {
      threads: Array<{ threadId: string; acpSessionId: string }>;
    };
    assertEquals(listed.threads, [{
      ...listed.threads[0],
      threadId: prepared.thread.threadId,
      acpSessionId: prepared.thread.acpSessionId,
    }]);
    acp.close();
    rpc.close();
  } finally {
    await server.shutdown();
    await portal.close();
    await removePath(root, { recursive: true });
  }
});

test('Portal archives and restores durable Threads without conflating active prompts or ACP deletion', async () => {
  const root = await temporaryDirectory({
    prefix: 'weave-product-portal-archive-',
  });
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath);
  const fakeAgent = join(
    dirname(fileURLToPath(import.meta.url)),
    'test-fixtures',
    'fake-agent.ts',
  );
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    displayName: 'Archive Portal',
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    workspaces: [{
      workspaceId: 'workspace',
      name: 'Workspace',
      path: workspacePath,
    }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: process.execPath,
      args: [fakeAgent],
      env: {},
    }],
  };

  let portal = await Portal.open(config);
  const credential = await pairTestCredential(portal);
  let server = startPortalServer(portal);
  let rpc: RpcSocket | undefined;
  let acp: RpcSocket | undefined;
  try {
    let address = server.addr as { hostname: string; port: number };
    rpc = await RpcSocket.open(
      `ws://127.0.0.1:${address.port}/rpc`,
      credential,
    );
    const capabilities = await rpc.request('portal.capabilities') as {
      capabilities: string[];
    };
    assertEquals(capabilities.capabilities.includes('thread.archive'), true);
    assertEquals(capabilities.capabilities.includes('thread.restore'), true);

    const created = await rpc.request('thread.create', {
      workspaceId: 'workspace',
      agentId: 'fake',
    }) as {
      thread: { threadId: string; acpSessionId: string };
    };
    const unknown = await assertRejects(
      () => rpc!.request('thread.archive', { threadId: crypto.randomUUID() }),
      RpcResponseError,
      'Resource is unavailable.',
    );
    const restrictedKey = await generatePortalKey();
    const restrictedGrants = portal.security.defaultGrants();
    restrictedGrants.workspaceIds = [];
    const restrictedToken = await portal.security.createPairingToken(
      60_000,
      restrictedGrants,
    );
    const restrictedPairing = await portal.security.redeemPairing({
      type: PORTAL_PAIR_REQUEST_TYPE,
      token: restrictedToken,
      label: 'Restricted archive client',
      publicKey: restrictedKey.publicKey,
    });
    const restricted = await RpcSocket.open(
      `ws://127.0.0.1:${address.port}/rpc`,
      {
        ...restrictedKey,
        credentialId: restrictedPairing.principal.credentialId,
      },
    );
    const unauthorized = await assertRejects(
      () =>
        restricted.request('thread.archive', {
          threadId: created.thread.threadId,
        }),
      RpcResponseError,
      'Resource is unavailable.',
    );
    restricted.close();
    assertEquals(
      {
        message: unauthorized.message,
        code: unauthorized.code,
        resourceCode: (unauthorized.data as { code?: string }).code,
      },
      {
        message: unknown.message,
        code: unknown.code,
        resourceCode: (unknown.data as { code?: string }).code,
      },
    );
    const attachment = await rpc.request('thread.attach', {
      threadId: created.thread.threadId,
    }) as {
      connection: { path: string; threadId: string };
    };
    acp = await RpcSocket.open(
      `ws://127.0.0.1:${address.port}${attachment.connection.path}?threadId=${created.thread.threadId}`,
      credential,
    );
    await acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    await acp.request('session/load', {
      sessionId: created.thread.acpSessionId,
      cwd: workspacePath,
      mcpServers: [],
    });

    const prompting = acp.request('session/prompt', {
      sessionId: created.thread.acpSessionId,
      prompt: [{ type: 'text', text: 'SLOW ARCHIVE' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const busy = await assertRejects(
      () => rpc!.request('thread.archive', { threadId: created.thread.threadId }),
      RpcResponseError,
      'Stop the active prompt',
    );
    assertEquals(busy.code, -32011);
    assertEquals(busy.data, {
      domain: 'thread-lifecycle',
      code: 'THREAD_BUSY',
    });
    await prompting;

    const archived = await rpc.request('thread.archive', {
      threadId: created.thread.threadId,
    }) as {
      thread: {
        threadId: string;
        acpSessionId: string;
        status: string;
        archivedAt?: string;
      };
    };
    assertEquals(archived.thread.threadId, created.thread.threadId);
    assertEquals(archived.thread.acpSessionId, created.thread.acpSessionId);
    assertEquals(archived.thread.status, 'archived');
    assertEquals(typeof archived.thread.archivedAt, 'string');
    assertEquals(
      (await rpc.request('thread.list') as { threads: unknown[] }).threads,
      [],
    );
    assertEquals(
      (await rpc.request('thread.list', { status: 'archived' }) as {
        threads: Array<{ threadId: string }>;
      }).threads
        .map(({ threadId }) => threadId),
      [created.thread.threadId],
    );
    await assertRejects(
      () => rpc!.request('thread.attach', { threadId: created.thread.threadId }),
      RpcResponseError,
      'Resource is unavailable.',
    );
    rpc.close();
    rpc = undefined;
    acp.close();
    acp = undefined;
    await server.shutdown();
    await portal.close();

    portal = await Portal.open(config);
    server = startPortalServer(portal);
    address = server.addr as { hostname: string; port: number };
    rpc = await RpcSocket.open(
      `ws://127.0.0.1:${address.port}/rpc`,
      credential,
    );
    const afterRestart = await rpc.request('thread.list', {
      status: 'archived',
    }) as {
      threads: Array<
        { threadId: string; acpSessionId: string; status: string }
      >;
    };
    assertEquals(
      afterRestart.threads.map(({ threadId, acpSessionId, status }) => ({
        threadId,
        acpSessionId,
        status,
      })),
      [{
        threadId: created.thread.threadId,
        acpSessionId: created.thread.acpSessionId,
        status: 'archived',
      }],
    );

    const restored = await rpc.request('thread.restore', {
      threadId: created.thread.threadId,
    }) as {
      thread: {
        threadId: string;
        acpSessionId: string;
        status: string;
        archivedAt?: string;
      };
    };
    assertEquals(restored.thread.status, 'active');
    assertEquals(restored.thread.acpSessionId, created.thread.acpSessionId);
    assertEquals(restored.thread.archivedAt, undefined);
    const reattached = await rpc.request('thread.attach', {
      threadId: created.thread.threadId,
    }) as {
      connection: { path: string; threadId: string };
    };
    acp = await RpcSocket.open(
      `ws://127.0.0.1:${address.port}${reattached.connection.path}?threadId=${created.thread.threadId}`,
      credential,
    );
    await acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    await acp.request('session/load', {
      sessionId: created.thread.acpSessionId,
      cwd: workspacePath,
      mcpServers: [],
    });
    await waitFor(() => acp!.notifications.some((message) => JSON.stringify(message).includes('SLOW ARCHIVE')));

    const audits = (await readText(
      join(config.stateDirectory, 'security-audit.jsonl'),
    ))
      .trim().split('\n').map((line) => JSON.parse(line) as { event?: string; threadId?: string });
    assertEquals(
      audits.some((audit) =>
        audit.event === 'thread.archived' &&
        audit.threadId === created.thread.threadId
      ),
      true,
    );
    assertEquals(
      audits.some((audit) =>
        audit.event === 'thread.restored' &&
        audit.threadId === created.thread.threadId
      ),
      true,
    );
  } finally {
    rpc?.close();
    acp?.close();
    await server.shutdown().catch(() => undefined);
    await portal.close();
    await removePath(root, { recursive: true });
  }
});

test('Portal replays durable Thread events after a daemon restart', async () => {
  const root = await temporaryDirectory({
    prefix: 'weave-product-portal-restart-',
  });
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath);
  const fakeAgent = join(
    dirname(fileURLToPath(import.meta.url)),
    'test-fixtures',
    'fake-agent.ts',
  );
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    displayName: 'Test Portal',
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    workspaces: [{
      workspaceId: 'workspace',
      name: 'Workspace',
      path: workspacePath,
    }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: process.execPath,
      args: [fakeAgent],
      env: {},
    }],
  };

  let threadId = '';
  const firstPortal = await Portal.open(config);
  const credential = await pairTestCredential(firstPortal);
  const firstServer = startPortalServer(firstPortal);
  const firstAddress = firstServer.addr as { hostname: string; port: number };
  try {
    const rpc = await RpcSocket.open(
      `ws://127.0.0.1:${firstAddress.port}/rpc`,
      credential,
    );
    const created = await rpc.request('thread.create', {
      workspaceId: 'workspace',
      agentId: 'fake',
    }) as {
      thread: { threadId: string; acpSessionId: string };
    };
    threadId = created.thread.threadId;
    const attached = await rpc.request('thread.attach', { threadId }) as {
      connection: { path: string; threadId: string };
    };
    const acp = await RpcSocket.open(
      `ws://127.0.0.1:${firstAddress.port}${attached.connection.path}?threadId=${threadId}`,
      credential,
    );
    await acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    await acp.request('session/load', {
      sessionId: 'fake-session',
      cwd: workspacePath,
      mcpServers: [],
    });
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
  const secondAddress = secondServer.addr as { hostname: string; port: number };
  try {
    const rpc = await RpcSocket.open(
      `ws://127.0.0.1:${secondAddress.port}/rpc`,
      credential,
    );
    const attached = await rpc.request('thread.attach', { threadId }) as {
      connection: { path: string; threadId: string };
    };
    const acp = await RpcSocket.open(
      `ws://127.0.0.1:${secondAddress.port}${attached.connection.path}?threadId=${threadId}`,
      credential,
    );
    await acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    await acp.request('session/load', {
      sessionId: 'fake-session',
      cwd: workspacePath,
      mcpServers: [],
    });
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
    await removePath(root, { recursive: true });
  }
});

test('Portal replaces a missing empty ACP session and closes the failed provider', async () => {
  const root = await temporaryDirectory({
    prefix: 'weave-product-portal-empty-session-',
  });
  const workspacePath = join(root, 'workspace');
  const stateDirectory = join(root, 'state');
  const processLog = join(root, 'processes.log');
  await mkdir(workspacePath);
  const fakeAgent = join(
    dirname(fileURLToPath(import.meta.url)),
    'test-fixtures',
    'fake-agent.ts',
  );
  const config = (recovery: 'load' | 'missing-session'): PortalConfig => ({
    listen: { hostname: '127.0.0.1', port: 0 },
    displayName: 'Test Portal',
    allowedOrigins: [],
    stateDirectory,
    workspaces: [{
      workspaceId: 'workspace',
      name: 'Workspace',
      path: workspacePath,
    }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: process.execPath,
      args: [
        `--allow-write=${processLog}`,
        fakeAgent,
        `--recovery=${recovery}`,
        `--process-log=${processLog}`,
      ],
      env: {},
    }],
  });

  let threadId = '';
  const firstPortal = await Portal.open(config('load'));
  const credential = await pairTestCredential(firstPortal);
  const firstServer = startPortalServer(firstPortal);
  const firstAddress = firstServer.addr as { hostname: string; port: number };
  try {
    const rpc = await RpcSocket.open(
      `ws://127.0.0.1:${firstAddress.port}/rpc`,
      credential,
    );
    const created = await rpc.request('thread.create', {
      workspaceId: 'workspace',
      agentId: 'fake',
    }) as {
      thread: { threadId: string; acpSessionId: string };
    };
    threadId = created.thread.threadId;
    assertEquals(created.thread.acpSessionId, 'fake-session');
    rpc.close();
  } finally {
    await firstServer.shutdown();
    await firstPortal.close();
  }

  const secondPortal = await Portal.open(config('missing-session'));
  const secondServer = startPortalServer(secondPortal);
  const secondAddress = secondServer.addr as { hostname: string; port: number };
  try {
    const rpc = await RpcSocket.open(
      `ws://127.0.0.1:${secondAddress.port}/rpc`,
      credential,
    );
    const attached = await rpc.request('thread.attach', { threadId }) as {
      thread: { threadId: string; acpSessionId: string };
      connection: { path: string; threadId: string; cwd: string };
    };
    assertEquals(
      {
        threadId: attached.thread.threadId,
        acpSessionId: attached.thread.acpSessionId,
      },
      { threadId, acpSessionId: 'replacement-session' },
    );
    const listed = await rpc.request('thread.list') as {
      threads: Array<{ threadId: string; acpSessionId: string }>;
    };
    assertEquals(
      listed.threads.map(({ threadId, acpSessionId }) => ({
        threadId,
        acpSessionId,
      })),
      [{
        threadId,
        acpSessionId: 'replacement-session',
      }],
    );

    const acp = await RpcSocket.open(
      `ws://127.0.0.1:${secondAddress.port}${attached.connection.path}?threadId=${threadId}`,
      credential,
    );
    await acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    await acp.request('session/load', {
      sessionId: 'replacement-session',
      cwd: workspacePath,
      mcpServers: [],
    });

    await waitFor(() => {
      const lines = readTextSync(processLog).trim().split('\n');
      const starts = lines.filter((line) => line.startsWith('start '));
      const stopped = new Set(
        lines.filter((line) => line.startsWith('stop ')).map((line) => line.slice(5)),
      );
      return starts.length >= 3 && stopped.has(starts[1].slice(6));
    });
    acp.close();
    rpc.close();
  } finally {
    await secondServer.shutdown();
    await secondPortal.close();
    await removePath(root, { recursive: true });
  }
});

test('Portal gives opted-in clients stable cursor replay without changing ordinary ACP replay', async () => {
  const root = await temporaryDirectory({
    prefix: 'weave-product-portal-cursor-',
  });
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath);
  const fakeAgent = join(
    dirname(fileURLToPath(import.meta.url)),
    'test-fixtures',
    'fake-agent.ts',
  );
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    displayName: 'Test Portal',
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    workspaces: [{
      workspaceId: 'workspace',
      name: 'Workspace',
      path: workspacePath,
    }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: process.execPath,
      args: [fakeAgent],
      env: {},
    }],
  };
  const portal = await Portal.open(config);
  const credential = await pairTestCredential(portal);
  const server = startPortalServer(portal);
  const address = server.addr as { hostname: string; port: number };
  const baseUrl = `ws://127.0.0.1:${address.port}`;
  try {
    const rpc = await RpcSocket.open(`${baseUrl}/rpc`, credential);
    const created = await rpc.request('thread.create', {
      workspaceId: 'workspace',
      agentId: 'fake',
    }) as {
      thread: { threadId: string };
    };
    const attached = await rpc.request('thread.attach', {
      threadId: created.thread.threadId,
    }) as {
      connection: { path: string; threadId: string };
    };
    const acpUrl = `${baseUrl}${attached.connection.path}?threadId=${attached.connection.threadId}`;

    const author = await RpcSocket.open(acpUrl, credential);
    await author.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    await author.request('session/load', {
      sessionId: 'fake-session',
      cwd: workspacePath,
      mcpServers: [],
    });
    await author.request('session/prompt', {
      sessionId: 'fake-session',
      prompt: [{ type: 'text', text: 'FIRST_CURSOR_TURN' }],
    });

    const native = await RpcSocket.open(acpUrl, credential);
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
        (message.params as { update: { _meta: Record<string, unknown> } })
          .update._meta['weave.dev/threadEvent']
      ),
      [
        {
          sequence: 1,
          eventId: (firstReplay[0].params as {
            update: { _meta: Record<string, { eventId: string }> };
          }).update
            ._meta['weave.dev/threadEvent'].eventId,
          createdAt: (firstReplay[0].params as {
            update: { _meta: Record<string, { createdAt: string }> };
          }).update
            ._meta['weave.dev/threadEvent'].createdAt,
        },
        {
          sequence: 2,
          eventId: (firstReplay[1].params as {
            update: { _meta: Record<string, { eventId: string }> };
          }).update
            ._meta['weave.dev/threadEvent'].eventId,
          createdAt: (firstReplay[1].params as {
            update: { _meta: Record<string, { createdAt: string }> };
          }).update
            ._meta['weave.dev/threadEvent'].createdAt,
        },
      ],
    );
    const firstSync = native.notifications.find((message) => message.method === '_weave.dev/thread_events/sync');
    assertEquals(firstSync?.params, {
      sessionId: 'fake-session',
      lastSequence: 2,
      fullReload: false,
    });
    native.notifications.splice(0);

    await author.request('session/prompt', {
      sessionId: 'fake-session',
      prompt: [{ type: 'text', text: 'SECOND_CURSOR_TURN' }],
    });
    await waitFor(() => native.notifications.filter((message) => message.method === 'session/update').length === 2);
    const liveSecondTurn = native.notifications.filter((message) => message.method === 'session/update');
    const liveMetadata = liveSecondTurn.map((message) =>
      (message.params as { update: { _meta: Record<string, unknown> } }).update
        ._meta['weave.dev/threadEvent']
    );
    assertEquals(
      liveMetadata.map((value) => (value as { sequence: number }).sequence),
      [3, 4],
    );
    native.close();

    const resumed = await RpcSocket.open(acpUrl, credential);
    await resumed.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
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
        (message.params as { update: { _meta: Record<string, unknown> } })
          .update._meta['weave.dev/threadEvent']
      ),
      liveMetadata,
    );
    assertEquals(
      resumed.notifications.find((message) => message.method === '_weave.dev/thread_events/sync')?.params,
      { sessionId: 'fake-session', lastSequence: 4, fullReload: false },
    );

    const ordinary = await RpcSocket.open(acpUrl, credential);
    await ordinary.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    await ordinary.request('session/load', {
      sessionId: 'fake-session',
      cwd: workspacePath,
      mcpServers: [],
    });
    const ordinaryUpdates = ordinary.notifications.filter((message) => message.method === 'session/update');
    assertEquals(ordinaryUpdates.length, 4);
    assertEquals(
      ordinaryUpdates.every((message) =>
        (message.params as { update: { _meta?: unknown } }).update._meta ===
          undefined
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
    await removePath(root, { recursive: true });
  }
});

test('Portal persists bounded replay gaps and enforces monotonic acknowledgements', async () => {
  const root = await temporaryDirectory({
    prefix: 'weave-product-portal-retention-',
  });
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath);
  const fakeAgent = join(
    dirname(fileURLToPath(import.meta.url)),
    'test-fixtures',
    'fake-agent.ts',
  );
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    displayName: 'Test Portal',
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    threadEventRetentionLimit: 2,
    workspaces: [{
      workspaceId: 'workspace',
      name: 'Workspace',
      path: workspacePath,
    }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: process.execPath,
      args: [
        fakeAgent,
        '--replay-transcript',
      ],
      env: {},
    }],
  };

  let threadId = '';
  const firstPortal = await Portal.open(config);
  const credential = await pairTestCredential(firstPortal);
  const firstServer = startPortalServer(firstPortal);
  const firstAddress = firstServer.addr as { hostname: string; port: number };
  try {
    const rpc = await RpcSocket.open(
      `ws://127.0.0.1:${firstAddress.port}/rpc`,
      credential,
    );
    const created = await rpc.request('thread.create', {
      workspaceId: 'workspace',
      agentId: 'fake',
    }) as {
      thread: { threadId: string };
    };
    threadId = created.thread.threadId;
    const attached = await rpc.request('thread.attach', { threadId }) as {
      connection: { path: string; threadId: string };
    };
    const acp = await RpcSocket.open(
      `ws://127.0.0.1:${firstAddress.port}${attached.connection.path}?threadId=${threadId}`,
      credential,
    );
    await acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    await acp.request('session/load', {
      sessionId: 'fake-session',
      cwd: workspacePath,
      mcpServers: [],
    });
    for (const prompt of ['RETAINED_FIRST', 'RETAINED_SECOND']) {
      await acp.request('session/prompt', {
        sessionId: 'fake-session',
        prompt: [{ type: 'text', text: prompt }],
      });
    }
    const acpUrl = `ws://127.0.0.1:${firstAddress.port}${attached.connection.path}?threadId=${threadId}`;
    const ordinary = await RpcSocket.open(acpUrl, credential);
    await ordinary.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    await ordinary.request('session/load', {
      sessionId: 'fake-session',
      cwd: workspacePath,
      mcpServers: [],
    });
    assertEquals(
      ordinary.notifications.filter((message) => message.method === 'session/update').length,
      4,
    );

    const native = await RpcSocket.open(acpUrl, credential);
    await native.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    await native.request('session/load', {
      sessionId: 'fake-session',
      cwd: workspacePath,
      mcpServers: [],
      _meta: { 'weave.dev/threadEvents': { afterSequence: null } },
    });
    assertEquals(
      native.notifications.filter((message) => message.method === 'session/update').length,
      4,
    );
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
  const secondAddress = secondServer.addr as { hostname: string; port: number };
  try {
    const rpc = await RpcSocket.open(
      `ws://127.0.0.1:${secondAddress.port}/rpc`,
      credential,
    );
    const attached = await rpc.request('thread.attach', { threadId }) as {
      connection: { path: string; threadId: string };
    };
    const acpUrl = `ws://127.0.0.1:${secondAddress.port}${attached.connection.path}?threadId=${threadId}`;

    const stale = await RpcSocket.open(acpUrl, credential);
    await stale.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
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
    assertEquals(
      gap instanceof RpcResponseError && { code: gap.code, data: gap.data },
      {
        code: -32060,
        data: {
          code: 'RESUME_GAP',
          compactedThrough: 2,
          lastSequence: 4,
          reloadAfterSequence: null,
        },
      },
    );
    stale.close();

    const resumed = await RpcSocket.open(acpUrl, credential);
    await resumed.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
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
          (message.params as {
            update: { _meta: Record<string, { sequence: number }> };
          }).update._meta[
            'weave.dev/threadEvent'
          ].sequence
        ),
      [3, 4],
    );
    assertEquals(
      await resumed.request('_weave.dev/thread_events/ack', {
        sessionId: 'fake-session',
        sequence: 4,
      }),
      { acknowledgedSequence: 4 },
    );
    let regressed: unknown;
    try {
      await resumed.request('_weave.dev/thread_events/ack', {
        sessionId: 'fake-session',
        sequence: 3,
      });
    } catch (cause) {
      regressed = cause;
    }
    assertEquals(
      regressed instanceof RpcResponseError && regressed.code,
      -32060,
    );

    resumed.close();
    rpc.close();
  } finally {
    await secondServer.shutdown();
    await secondPortal.close();
    await removePath(root, { recursive: true });
  }
});

test('Portal recovers an uncertain prompt with durable fenced runtime generations', async () => {
  const root = await temporaryDirectory({
    prefix: 'weave-product-portal-recovery-',
  });
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath);
  const fakeAgent = join(
    dirname(fileURLToPath(import.meta.url)),
    'test-fixtures',
    'fake-agent.ts',
  );
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    displayName: 'Test Portal',
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    workspaces: [{
      workspaceId: 'workspace',
      name: 'Workspace',
      path: workspacePath,
    }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: process.execPath,
      args: [
        fakeAgent,
        '--recovery=resume-fails-then-load',
      ],
      env: {},
    }],
  };

  let threadId = '';
  const firstPortal = await Portal.open(config);
  const credential = await pairTestCredential(firstPortal);
  const firstServer = startPortalServer(firstPortal);
  const firstAddress = firstServer.addr as { hostname: string; port: number };
  try {
    const rpc = await RpcSocket.open(
      `ws://127.0.0.1:${firstAddress.port}/rpc`,
      credential,
    );
    const created = await rpc.request('thread.create', {
      workspaceId: 'workspace',
      agentId: 'fake',
    }) as {
      thread: { threadId: string };
    };
    threadId = created.thread.threadId;
    const attached = await rpc.request('thread.attach', { threadId }) as {
      connection: { path: string; threadId: string };
    };
    const acp = await RpcSocket.open(
      `ws://127.0.0.1:${firstAddress.port}${attached.connection.path}?threadId=${threadId}`,
      credential,
    );
    const initialized = await acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    }) as {
      agentCapabilities: {
        _meta: Record<string, { runtimeRecovery: unknown }>;
      };
    };
    assertEquals(
      initialized.agentCapabilities._meta['weave.dev'].runtimeRecovery,
      {
        version: 1,
        stateNotification: '_weave.dev/runtime/state',
      },
    );
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
    assertEquals(
      uncertain instanceof RpcResponseError &&
        { code: uncertain.code, data: uncertain.data },
      {
        code: -32050,
        data: { code: 'PROMPT_UNCERTAIN', generation: 1 },
      },
    );
    await waitFor(() =>
      acp.notifications.filter((message) => message.method === '_weave.dev/runtime/state').length === 3
    );
    assertEquals(
      acp.notifications
        .filter((message) => message.method === '_weave.dev/runtime/state')
        .map((message) => {
          const params = message.params as {
            generation: number;
            state: string;
            code: string;
          };
          return {
            generation: params.generation,
            state: params.state,
            code: params.code,
          };
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
        JSON.stringify(message).includes(
          'FAKE_AGENT_LOAD_AFTER_RESUME:AFTER_RECOVERY',
        )
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
  const secondAddress = secondServer.addr as { hostname: string; port: number };
  try {
    const rpc = await RpcSocket.open(
      `ws://127.0.0.1:${secondAddress.port}/rpc`,
      credential,
    );
    const attached = await rpc.request('thread.attach', { threadId }) as {
      connection: { path: string; threadId: string };
    };
    const acp = await RpcSocket.open(
      `ws://127.0.0.1:${secondAddress.port}${attached.connection.path}?threadId=${threadId}`,
      credential,
    );
    await acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
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
        prompt: [{ type: 'text', text: 'CRASH_AFTER_RESTART' }],
      });
    } catch (cause) {
      uncertain = cause;
    }
    assertEquals(
      uncertain instanceof RpcResponseError &&
        (uncertain.data as { generation?: unknown }).generation,
      3,
    );
    await waitFor(() =>
      acp.notifications.some((message) =>
        message.method === '_weave.dev/runtime/state' &&
        (message.params as { generation?: unknown; code?: unknown })
            .generation === 4 &&
        (message.params as { generation?: unknown; code?: unknown }).code ===
          'RECOVERED'
      )
    );
    acp.close();
    rpc.close();
  } finally {
    await secondServer.shutdown();
    await secondPortal.close();
    await removePath(root, { recursive: true });
  }
});

test('Portal exposes an explicit unavailable state when an Agent cannot resume', async () => {
  const root = await temporaryDirectory({
    prefix: 'weave-product-portal-cannot-resume-',
  });
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath);
  const fakeAgent = join(
    dirname(fileURLToPath(import.meta.url)),
    'test-fixtures',
    'fake-agent.ts',
  );
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    displayName: 'Test Portal',
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    workspaces: [{
      workspaceId: 'workspace',
      name: 'Workspace',
      path: workspacePath,
    }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: process.execPath,
      args: [fakeAgent, '--recovery=none'],
      env: {},
    }],
  };
  const portal = await Portal.open(config);
  const credential = await pairTestCredential(portal);
  const server = startPortalServer(portal);
  const address = server.addr as { hostname: string; port: number };
  try {
    const rpc = await RpcSocket.open(
      `ws://127.0.0.1:${address.port}/rpc`,
      credential,
    );
    const created = await rpc.request('thread.create', {
      workspaceId: 'workspace',
      agentId: 'fake',
    }) as {
      thread: { threadId: string };
    };
    const attached = await rpc.request('thread.attach', {
      threadId: created.thread.threadId,
    }) as {
      connection: { path: string; threadId: string };
    };
    const acp = await RpcSocket.open(
      `ws://127.0.0.1:${address.port}${attached.connection.path}?threadId=${attached.connection.threadId}`,
      credential,
    );
    await acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    });
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
          const params = message.params as {
            generation: number;
            state: string;
            code: string;
          };
          return {
            generation: params.generation,
            state: params.state,
            code: params.code,
          };
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
    assertEquals(
      unavailable instanceof RpcResponseError &&
        { code: unavailable.code, data: unavailable.data },
      {
        code: -32050,
        data: { code: 'CANNOT_RESUME', generation: 2 },
      },
    );

    acp.close();
    rpc.close();
  } finally {
    await server.shutdown();
    await portal.close();
    await removePath(root, { recursive: true });
  }
});

test('Portal rejects an unpaired key before exposing metadata', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-product-portal-auth-' });
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    displayName: 'Authentication Portal',
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    workspaces: [{ workspaceId: 'workspace', name: 'Workspace', path: root }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: 'false',
      args: [],
      env: {},
    }],
  };
  const portal = await Portal.open(config);
  const server = startPortalServer(portal);
  const address = server.addr as { hostname: string; port: number };
  try {
    const unpaired = await generatePortalKey();
    await assertRejects(() =>
      RpcSocket.open(`ws://127.0.0.1:${address.port}/rpc`, {
        ...unpaired,
        credentialId: crypto.randomUUID(),
      })
    );
  } finally {
    await server.shutdown();
    await portal.close();
    await removePath(root, { recursive: true });
  }
});

test('Portal revocation rejects active requests and new key proofs', async () => {
  const root = await temporaryDirectory({
    prefix: 'weave-product-portal-revocation-',
  });
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    displayName: 'Revocation Portal',
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    workspaces: [{ workspaceId: 'workspace', name: 'Workspace', path: root }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: 'false',
      args: [],
      env: {},
    }],
  };
  const portal = await Portal.open(config);
  const credential = await pairTestCredential(portal);
  const server = startPortalServer(portal);
  const address = server.addr as { hostname: string; port: number };
  const url = `ws://127.0.0.1:${address.port}/rpc`;
  const active = await RpcSocket.open(url, credential);
  try {
    assertEquals(
      await portal.security.revokeCredential(credential.credentialId),
      true,
    );
    await assertRejects(
      () => active.request('portal.capabilities'),
      Error,
      'CREDENTIAL_REVOKED',
    );
    await assertRejects(() => RpcSocket.open(url, credential));
  } finally {
    active.close();
    await server.shutdown();
    await portal.close();
    await removePath(root, { recursive: true });
  }
});

test('Alpha-facing Portal exposes typed Workspace file operations and connection-scoped changes', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-product-files-rpc-' });
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath);
  await writeText(join(workspacePath, 'README.md'), '# WVE-42\n');
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 },
    displayName: 'Test Portal',
    allowedOrigins: [],
    stateDirectory: join(root, 'state'),
    workspaces: [{
      workspaceId: 'workspace',
      name: 'Workspace',
      path: workspacePath,
    }],
    agents: [{
      agentId: 'fake',
      name: 'Fake',
      command: 'false',
      args: [],
      env: {},
    }],
  };
  const portal = await Portal.open(config);
  const credential = await pairTestCredential(portal);
  const server = startPortalServer(portal);
  const address = server.addr as { hostname: string; port: number };
  const rpc = await RpcSocket.open(
    `ws://127.0.0.1:${address.port}/rpc`,
    credential,
  );
  try {
    const capabilities = await rpc.request('portal.capabilities') as {
      capabilities: string[];
    };
    assertEquals(
      capabilities.capabilities.includes('workspace.file.read'),
      true,
    );

    const listed = await rpc.request('workspace.file.list', {
      workspaceId: 'workspace',
      path: '',
    }) as {
      entries: Array<{ path: string }>;
    };
    assertEquals(listed.entries.map((entry) => entry.path), ['README.md']);
    const read = await rpc.request('workspace.file.read', {
      workspaceId: 'workspace',
      path: 'README.md',
    }) as {
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
    assertEquals(
      stale instanceof RpcResponseError &&
        { code: stale.code, data: stale.data },
      {
        code: -32010,
        data: {
          domain: 'workspace-filesystem',
          code: 'STALE_CONTENT',
          path: 'README.md',
          expectedContentHash: '0'.repeat(64),
          actualContentHash: read.contentHash,
        },
      },
    );

    await rpc.request('workspace.directory.create', {
      workspaceId: 'workspace',
      path: 'non-empty',
    });
    await rpc.request('workspace.file.write', {
      workspaceId: 'workspace',
      path: 'non-empty/file.txt',
      content: 'content',
      expectedContentHash: null,
    });
    let nonEmpty: unknown;
    try {
      await rpc.request('workspace.file.delete', {
        workspaceId: 'workspace',
        path: 'non-empty',
      });
    } catch (cause) {
      nonEmpty = cause;
    }
    assertEquals(
      nonEmpty instanceof RpcResponseError &&
        { code: nonEmpty.code, data: nonEmpty.data },
      {
        code: -32010,
        data: {
          domain: 'workspace-filesystem',
          code: 'DIRECTORY_NOT_EMPTY',
          path: 'non-empty',
        },
      },
    );
    assertEquals(JSON.stringify(nonEmpty).includes(workspacePath), false);

    const watch = await rpc.request('workspace.file.watch.start', {
      workspaceId: 'workspace',
      paths: [''],
    }) as {
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
        message.method === WORKSPACE_FILE_WATCH_EVENT_METHOD &&
        (JSON.stringify(message.params).includes('created.txt') ||
          ((message.params as { event?: { rescan?: boolean; affectedDirectories?: string[] } }).event?.rescan === true &&
            (message.params as { event: { affectedDirectories: string[] } }).event.affectedDirectories.includes('')))
      )
    );
    assertEquals(
      await rpc.request('workspace.file.watch.stop', {
        subscriptionId: watch.subscriptionId,
      }),
      {
        ok: true,
      },
    );
  } finally {
    rpc.close();
    await server.shutdown();
    await portal.close();
    await removePath(root, { recursive: true });
  }
});

test('Authenticated context summaries preserve Host identity and filter canonical paths by grants', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-context-rpc-' });
  await mkdir(join(root, 'allowed'));
  await mkdir(join(root, 'private'));
  await symlink(join(root, 'allowed'), join(root, 'alias'));
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 }, displayName: 'Context Host',
    allowedOrigins: [], stateDirectory: join(root, 'state'),
    workspaces: [
      { workspaceId: 'allowed-id', name: 'Checkout', path: join(root, 'alias') },
      { workspaceId: 'private-id', name: 'Checkout', path: join(root, 'private') },
    ],
    agents: [],
  };
  let portal = await Portal.open(config, { terminalBackend: false });
  const key = await generatePortalKey();
  const grants = portal.security.defaultGrants();
  grants.workspaceIds = ['allowed-id'];
  grants.actions = ['portal.inspect', 'workspace.inspect', 'workspace.file.read'];
  const token = await portal.security.createPairingToken(60_000, grants);
  const paired = await portal.security.redeemPairing({ type: PORTAL_PAIR_REQUEST_TYPE, token, label: 'Context reader', publicKey: key.publicKey });
  const credential = { ...key, credentialId: paired.principal.credentialId };
  const hostId = portal.security.hostId;
  let server = startPortalServer(portal);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const rpc = await RpcSocket.open(`ws://127.0.0.1:${server.addr.port}/rpc`, credential);
      try {
        const capabilities = await rpc.request('portal.capabilities') as { hostId: string; capabilities: string[] };
        assertEquals(capabilities.hostId, hostId);
        assertEquals(capabilities.capabilities.includes(WORKSPACE_CONTEXT_CAPABILITY), true);
        assertEquals(await rpc.request('workspace.list'), {
          workspaces: [{ workspaceId: 'allowed-id', name: 'Checkout', rootName: 'allowed', canonicalPath: await realpath(join(root, 'allowed')) }],
        });
        await assertRejects(() => rpc.request('workspace.file.list', { workspaceId: 'private-id', path: '' }));
      } finally { rpc.close(); }
      if (attempt === 0) {
        await server.shutdown();
        await portal.close();
        portal = await Portal.open(config, { terminalBackend: false });
        server = startPortalServer(portal);
      }
    }
  } finally {
    await server.shutdown();
    await portal.close();
    await removePath(root, { recursive: true });
  }
});

test('Authenticated compositions enforce ownership and revisions, survive restart, and never control terminal lifetime', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-composition-rpc-' });
  await mkdir(join(root, 'allowed'));
  await mkdir(join(root, 'private'));
  const config: PortalConfig = {
    listen: { hostname: '127.0.0.1', port: 0 }, displayName: 'Composition Host', allowedOrigins: [],
    stateDirectory: join(root, 'state'), agents: [], workspaces: [
      { workspaceId: 'allowed', name: 'Allowed', path: join(root, 'allowed') },
      { workspaceId: 'private', name: 'Private', path: join(root, 'private') },
    ],
  };
  const backend = new InMemoryTerminalBackend();
  let portal = await Portal.open(config, { terminalBackend: backend });
  let server = startPortalServer(portal);
  const credential = await pairTestCredential(portal);
  const sockets: RpcSocket[] = [];
  const connect = async (signer = credential) => {
    const socket = await RpcSocket.open(`ws://127.0.0.1:${server.addr.port}/rpc`, signer);
    sockets.push(socket);
    return socket;
  };
  try {
    const first = await connect();
    const second = await connect();
    const capabilities = await first.request('portal.capabilities') as { capabilities: string[] };
    assertEquals(capabilities.capabilities.includes('workspace.composition.replace'), true);
    const initial = { composition: { schemaVersion: 1, workspaceId: 'allowed', revision: 0, tabs: [] } };
    assertEquals(await first.request('workspace.composition.get', { workspaceId: 'allowed' }), initial);
    const { terminal } = await first.request('terminal.create', { workspaceId: 'allowed', cols: 80, rows: 24 }) as { terminal: { terminalId: string } };
    const { terminal: privateTerminal } = await first.request('terminal.create', { workspaceId: 'private', cols: 80, rows: 24 }) as { terminal: { terminalId: string } };
    const tabs = [{ tabId: 'tab', name: 'Build', layout: { kind: 'terminal', nodeId: 'node', paneId: 'pane', terminalId: terminal.terminalId } }];
    const replace = (rpc: RpcSocket, expectedRevision: number, nextTabs: unknown = tabs, workspaceId = 'allowed') => rpc.request('workspace.composition.replace', { workspaceId, expectedRevision, tabs: nextTabs });
    const concurrent = await Promise.allSettled([replace(first, 0), replace(second, 0)]);
    assertEquals(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
    const conflict = concurrent.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    assertEquals(conflict.reason instanceof RpcResponseError && conflict.reason.data, { domain: 'composition', code: 'STALE_REVISION', currentRevision: 1 });
    for (const terminalId of ['missing-terminal', privateTerminal.terminalId]) {
      const invalid = await assertRejects(() => replace(first, 1, [{ ...tabs[0], layout: { ...tabs[0]!.layout, terminalId } }]));
      assertEquals(invalid instanceof RpcResponseError && invalid.data, { domain: 'composition', code: 'INVALID_TARGET' });
    }
    // A reader of one context cannot inspect another, nor edit even its own context.
    const key = await generatePortalKey();
    const grants = portal.security.defaultGrants();
    grants.workspaceIds = ['allowed'];
    grants.actions = ['portal.inspect', 'workspace.inspect'];
    const token = await portal.security.createPairingToken(60_000, grants);
    const paired = await portal.security.redeemPairing({ type: PORTAL_PAIR_REQUEST_TYPE, token, label: 'Read only', publicKey: key.publicKey });
    const reader = await connect({ ...key, credentialId: paired.principal.credentialId });
    await assertRejects(() => reader.request('workspace.composition.get', { workspaceId: 'private' }));
    await assertRejects(() => replace(reader, 1));
    assertEquals(await reader.request('workspace.composition.get', { workspaceId: 'allowed' }), { composition: { ...initial.composition, revision: 1, tabs } });
    for (const socket of sockets.splice(0)) socket.close();
    await server.shutdown();
    await portal.close();
    portal = await Portal.open(config, { terminalBackend: backend });
    server = startPortalServer(portal);
    const restored = await connect();
    assertEquals(await restored.request('workspace.composition.get', { workspaceId: 'allowed' }), { composition: { ...initial.composition, revision: 1, tabs } });
    await replace(restored, 1, []);
    const terminals = await restored.request('terminal.list', { workspaceId: 'allowed' }) as { terminals: Array<{ terminalId: string }> };
    assertEquals(terminals.terminals.some((item) => item.terminalId === terminal.terminalId), true);
  } finally {
    for (const socket of sockets) socket.close();
    await server.shutdown();
    await portal.close();
    await removePath(root, { recursive: true });
  }
});
