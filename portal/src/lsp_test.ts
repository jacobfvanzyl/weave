import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1.0.19';
import { detectLspLanguageId, PortalLspHost } from './lsp.ts';

type CapturedJsonRpcEvent = {
  jsonrpc?: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
};

const withTempWorkspace = async (
  callback: (context: { root: string; host: PortalLspHost }) => Promise<void>,
) => {
  const root = await Deno.makeTempDir({ prefix: 'weave-lsp-root-' });
  const host = new PortalLspHost({ config: { roots: [{ id: 'default', path: root }] } });
  try {
    await callback({ root: await Deno.realPath(root), host });
  } finally {
    await host.dispose();
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
};

const fakeLspServerSource = `
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const concatBytes = (left, right) => {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left, 0);
  output.set(right, left.byteLength);
  return output;
};
const headerEndIndex = (buffer) => {
  for (let index = 0; index <= buffer.byteLength - 4; index += 1) {
    if (buffer[index] === 13 && buffer[index + 1] === 10 && buffer[index + 2] === 13 && buffer[index + 3] === 10) return index;
  }
  return -1;
};
const write = async (message) => {
  const body = encoder.encode(JSON.stringify(message));
  const header = encoder.encode(\`Content-Length: \${body.byteLength}\\r\\n\\r\\n\`);
  const framed = concatBytes(header, body);
  await Deno.stdout.write(framed);
};
const reader = Deno.stdin.readable.getReader();
let buffer = new Uint8Array(0);
const publishDiagnostics = !Deno.args.includes('--no-publish-diagnostics');
const requireWorkspaceConfiguration = Deno.args.includes('--require-workspace-configuration');
const diagnosticSource = publishDiagnostics ? 'fake-lsp' : 'fake-pull-lsp';
const diagnosticMessage = publishDiagnostics ? 'fake diagnostic' : 'fake pull diagnostic';
const publishedDiagnosticUris = new Set();
let hasWorkspaceConfiguration = !requireWorkspaceConfiguration;
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer = concatBytes(buffer, value);
  while (true) {
    const headerEnd = headerEndIndex(buffer);
    if (headerEnd === -1) break;
    const header = decoder.decode(buffer.subarray(0, headerEnd));
    const match = /content-length:\\s*(\\d+)/i.exec(header);
    const length = Number(match?.[1] ?? 0);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.byteLength < bodyEnd) break;
    const message = JSON.parse(decoder.decode(buffer.subarray(bodyStart, bodyEnd)));
    buffer = buffer.subarray(bodyEnd);
    if (message.id === 'fake-config' && message.method === undefined) {
      hasWorkspaceConfiguration = Array.isArray(message.result) && message.result.length > 0;
    } else if (message.method === 'initialize') {
      await write({ jsonrpc: '2.0', id: message.id, result: { capabilities: {
        textDocumentSync: 1,
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        documentSymbolProvider: true,
        diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
        codeActionProvider: true,
        documentFormattingProvider: true,
        renameProvider: true,
        workspaceSymbolProvider: true
      } } });
      if (requireWorkspaceConfiguration) {
        await write({ jsonrpc: '2.0', id: 'fake-config', method: 'workspace/configuration', params: {
          items: [{ section: 'deno' }]
        } });
      }
    } else if (message.method === 'textDocument/didOpen') {
      if (publishDiagnostics && hasWorkspaceConfiguration && !publishedDiagnosticUris.has(message.params.textDocument.uri)) {
        publishedDiagnosticUris.add(message.params.textDocument.uri);
        await write({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: {
          uri: message.params.textDocument.uri,
          version: message.params.textDocument.version,
          diagnostics: [{ source: diagnosticSource, severity: 2, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, message: diagnosticMessage }]
        } });
      }
    } else if (message.method === 'textDocument/diagnostic') {
      await write({ jsonrpc: '2.0', id: message.id, result: {
        kind: 'full',
        items: hasWorkspaceConfiguration
          ? [{ source: diagnosticSource, severity: 2, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, message: diagnosticMessage }]
          : []
      } });
    } else if (message.method === 'textDocument/hover') {
      await write({ jsonrpc: '2.0', id: message.id, result: { contents: { kind: 'markdown', value: '**hover** from fake server' } } });
    } else if (message.method === 'shutdown') {
      await write({ jsonrpc: '2.0', id: message.id, result: null });
    } else if (message.method === 'exit') {
      Deno.exit(0);
    } else if (message.id !== undefined) {
      await write({ jsonrpc: '2.0', id: message.id, result: null });
    }
  }
}
`;

const findJsonRpcEvent = (
  events: unknown[],
  predicate: (message: CapturedJsonRpcEvent) => boolean,
): CapturedJsonRpcEvent | undefined => {
  for (const event of events) {
    if (!event || typeof event !== 'object' || (event as { type?: string }).type !== 'jsonrpc') continue;
    const rawMessage = (event as { message?: unknown }).message;
    if (typeof rawMessage !== 'string') continue;
    const message = JSON.parse(rawMessage) as CapturedJsonRpcEvent;
    if (predicate(message)) return message;
  }
  return undefined;
};

const waitForJsonRpcEvent = async (
  events: unknown[],
  predicate: (message: CapturedJsonRpcEvent) => boolean,
) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const event = findJsonRpcEvent(events, predicate);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for JSON-RPC event.');
};

const initializeClient = async (
  host: PortalLspHost,
  clientId: string,
  sessionId: string,
  rootUri: string | undefined,
  send: (event: unknown) => void,
) => {
  await host.handleClientMessage(clientId, { type: 'start', sessionId }, send);
  await host.handleClientMessage(clientId, {
    type: 'jsonrpc',
    sessionId,
    message: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { rootUri, capabilities: {} },
    }),
  }, send);
};

const didOpen = async (
  host: PortalLspHost,
  clientId: string,
  sessionId: string,
  uri: string,
  send: (event: unknown) => void,
  languageId = 'typescript',
) =>
  await host.handleClientMessage(clientId, {
    type: 'jsonrpc',
    sessionId,
    message: JSON.stringify({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri,
          languageId,
          version: 0,
          text: 'const answer = 42;\n',
        },
      },
    }),
  }, send);

Deno.test('detectLspLanguageId maps common web language files', () => {
  assertEquals(detectLspLanguageId('src/App.tsx'), 'typescriptreact');
  assertEquals(detectLspLanguageId('src/index.ts'), 'typescript');
  assertEquals(detectLspLanguageId('package.json'), 'json');
  assertEquals(detectLspLanguageId('settings.jsonc'), 'jsonc');
  assertEquals(detectLspLanguageId('styles/app.css'), 'css');
  assertEquals(detectLspLanguageId('public/index.html'), 'html');
  assertEquals(detectLspLanguageId('README.md'), 'markdown');
});

Deno.test('PortalLspHost reports missing configured binaries without throwing', async () =>
  await withTempWorkspace(async ({ root, host }) => {
    await Deno.mkdir(`${root}/.weave`, { recursive: true });
    await Deno.writeTextFile(`${root}/main.ts`, 'const answer = 42;\\n');
    await Deno.writeTextFile(
      `${root}/.weave/language-servers.jsonc`,
      `{
      "servers": {
        "fake": {
          "enabled": true,
          "command": "./missing-lsp",
          "languages": ["typescript"],
          "rootMarkers": ["package.json", ".git"],
          "priority": 1000
        }
      }
    }`,
    );

    const session = await host.createSession({
      target: { workspacePath: root },
      path: 'main.ts',
      serverId: 'fake',
    });

    assertEquals(session.ok, true);
    assertEquals(session.status, 'missing');
    assertStringIncludes(session.error ?? '', 'missing-lsp');
  }));

Deno.test('PortalLspHost skips disabled optional providers when selecting a default server', async () =>
  await withTempWorkspace(async ({ root, host }) => {
    await Deno.mkdir(`${root}/.weave`, { recursive: true });
    await Deno.writeTextFile(`${root}/main.ts`, 'const answer = 42;\\n');
    await Deno.writeTextFile(
      `${root}/.weave/language-servers.jsonc`,
      JSON.stringify({
        servers: {
          disabledHighPriority: {
            enabled: false,
            command: './missing-lsp',
            languages: ['typescript'],
            priority: 3000,
          },
          enabledLowPriority: {
            enabled: true,
            command: Deno.execPath(),
            args: ['--version'],
            languages: ['typescript'],
            priority: 2000,
          },
        },
      }),
    );

    const session = await host.createSession({
      target: { workspacePath: root },
      path: 'main.ts',
    });

    assertEquals(session.ok, true);
    assertEquals(session.status, 'ready');
    assertEquals(session.serverId, 'enabledLowPriority');
  }));

Deno.test('PortalLspHost only selects require_configuration servers when a root marker matches', async () =>
  await withTempWorkspace(async ({ root, host }) => {
    await Deno.mkdir(`${root}/.weave`, { recursive: true });
    await Deno.mkdir(`${root}/bragi`, { recursive: true });
    await Deno.writeTextFile(`${root}/main.ts`, 'const answer = 42;\n');
    await Deno.writeTextFile(`${root}/bragi/main.ts`, 'const answer = 42;\n');
    await Deno.writeTextFile(`${root}/bragi/deno.json`, '{}\n');
    await Deno.writeTextFile(
      `${root}/.weave/language-servers.jsonc`,
      JSON.stringify({
        servers: {
          denols: {
            enabled: true,
            command: Deno.execPath(),
            args: ['--version'],
            languages: ['typescript'],
            rootMarkers: ['deno.json', 'deno.jsonc'],
            priority: 3000,
            settings: { require_configuration: true },
          },
          typescript: {
            enabled: true,
            command: Deno.execPath(),
            args: ['--version'],
            languages: ['typescript'],
            rootMarkers: ['package.json', '.git'],
            priority: 100,
          },
        },
      }),
    );

    const rootSession = await host.createSession({
      target: { workspacePath: root },
      path: 'main.ts',
    });
    assertEquals(rootSession.ok, true);
    assertEquals(rootSession.status, 'ready');
    assertEquals(rootSession.serverId, 'typescript');
    assertEquals(rootSession.rootPath, root);

    const denoSession = await host.createSession({
      target: { workspacePath: root },
      path: 'bragi/main.ts',
    });
    assertEquals(denoSession.ok, true);
    assertEquals(denoSession.status, 'ready');
    assertEquals(denoSession.serverId, 'denols');
    assertEquals(denoSession.rootPath, `${root}/bragi`);
  }));

Deno.test('PortalLspHost speaks stdio JSON-RPC with a fake language server', async () =>
  await withTempWorkspace(async ({ root, host }) => {
    await Deno.mkdir(`${root}/.weave`, { recursive: true });
    await Deno.writeTextFile(`${root}/main.ts`, 'const answer = 42;\\n');
    const fakeServerPath = `${root}/fake-lsp.ts`;
    await Deno.writeTextFile(fakeServerPath, fakeLspServerSource);
    await Deno.writeTextFile(
      `${root}/.weave/language-servers.jsonc`,
      JSON.stringify({
        servers: {
          fake: {
            enabled: true,
            command: Deno.execPath(),
            args: ['run', '--quiet', fakeServerPath],
            languages: ['typescript'],
            rootMarkers: ['package.json', '.git'],
            priority: 1000,
          },
        },
      }),
    );

    const hover = await host.query({
      target: { workspacePath: root },
      path: 'main.ts',
      serverId: 'fake',
      feature: 'hover',
      line: 0,
      character: 6,
    }) as Record<string, any>;
    assertEquals(hover.ok, true);
    assertStringIncludes(hover.hover.contents.value, 'hover');

    const diagnostics = await host.query({
      target: { workspacePath: root },
      path: 'main.ts',
      serverId: 'fake',
      feature: 'diagnostics',
    }) as Record<string, any>;
    assertEquals(diagnostics.ok, true);
    assertEquals(diagnostics.diagnostics[0].source, 'fake-lsp');
  }));

Deno.test('PortalLspHost replays cached diagnostics across editor remounts without server versions', async () =>
  await withTempWorkspace(async ({ root, host }) => {
    await Deno.mkdir(`${root}/.weave`, { recursive: true });
    await Deno.writeTextFile(`${root}/main.ts`, 'const answer = 42;\n');
    const fakeServerPath = `${root}/fake-lsp.ts`;
    await Deno.writeTextFile(fakeServerPath, fakeLspServerSource);
    await Deno.writeTextFile(
      `${root}/.weave/language-servers.jsonc`,
      JSON.stringify({
        servers: {
          fake: {
            enabled: true,
            command: Deno.execPath(),
            args: ['run', '--quiet', fakeServerPath],
            languages: ['typescript'],
            rootMarkers: ['package.json', '.git'],
            priority: 1000,
          },
        },
      }),
    );

    const firstSession = await host.createSession({
      target: { workspacePath: root },
      path: 'main.ts',
      serverId: 'fake',
    });
    const firstEvents: unknown[] = [];
    const firstSend = (event: unknown) => firstEvents.push(event);
    await initializeClient(host, 'client-a', firstSession.sessionId, firstSession.rootUri, firstSend);
    await waitForJsonRpcEvent(firstEvents, (message) => message.id === 1);
    await didOpen(host, 'client-a', firstSession.sessionId, firstSession.documentUri!, firstSend);

    const firstDiagnostics = await waitForJsonRpcEvent(
      firstEvents,
      (message) => message.method === 'textDocument/publishDiagnostics',
    );
    assertEquals(firstDiagnostics.params?.version, undefined);
    assertEquals((firstDiagnostics.params?.diagnostics as Array<Record<string, unknown>>)[0]?.source, 'fake-lsp');

    host.detachClient('client-a', firstSession.sessionId);

    const secondSession = await host.createSession({
      target: { workspacePath: root },
      path: 'main.ts',
      serverId: 'fake',
    });
    const secondEvents: unknown[] = [];
    const secondSend = (event: unknown) => secondEvents.push(event);
    await initializeClient(host, 'client-b', secondSession.sessionId, secondSession.rootUri, secondSend);
    await waitForJsonRpcEvent(secondEvents, (message) => message.id === 1);
    await didOpen(host, 'client-b', secondSession.sessionId, secondSession.documentUri!, secondSend);

    const replayedDiagnostics = await waitForJsonRpcEvent(
      secondEvents,
      (message) => message.method === 'textDocument/publishDiagnostics',
    );
    assertEquals(replayedDiagnostics.params?.uri, secondSession.documentUri);
    assertEquals(replayedDiagnostics.params?.version, undefined);
    assertEquals(
      (replayedDiagnostics.params?.diagnostics as Array<Record<string, unknown>>)[0]?.message,
      'fake diagnostic',
    );
  }));

Deno.test('PortalLspHost bridges pull diagnostics into publishDiagnostics for editor clients', async () =>
  await withTempWorkspace(async ({ root, host }) => {
    await Deno.mkdir(`${root}/.weave`, { recursive: true });
    await Deno.writeTextFile(`${root}/main.ts`, 'const answer = 42;\n');
    const fakeServerPath = `${root}/fake-lsp.ts`;
    await Deno.writeTextFile(fakeServerPath, fakeLspServerSource);
    await Deno.writeTextFile(
      `${root}/.weave/language-servers.jsonc`,
      JSON.stringify({
        servers: {
          fake: {
            enabled: true,
            command: Deno.execPath(),
            args: ['run', '--quiet', fakeServerPath, '--no-publish-diagnostics'],
            languages: ['typescript'],
            rootMarkers: ['package.json', '.git'],
            priority: 1000,
          },
        },
      }),
    );

    const session = await host.createSession({
      target: { workspacePath: root },
      path: 'main.ts',
      serverId: 'fake',
    });
    const events: unknown[] = [];
    const send = (event: unknown) => events.push(event);
    await initializeClient(host, 'client-a', session.sessionId, session.rootUri, send);
    await waitForJsonRpcEvent(events, (message) => message.id === 1);
    await didOpen(host, 'client-a', session.sessionId, session.documentUri!, send);

    const diagnostics = await waitForJsonRpcEvent(
      events,
      (message) => message.method === 'textDocument/publishDiagnostics',
    );
    assertEquals(diagnostics.params?.version, undefined);
    assertEquals((diagnostics.params?.diagnostics as Array<Record<string, unknown>>)[0]?.source, 'fake-pull-lsp');
    assertEquals(
      (diagnostics.params?.diagnostics as Array<Record<string, unknown>>)[0]?.message,
      'fake pull diagnostic',
    );
  }));

Deno.test('PortalLspHost advertises and answers workspace configuration for diagnostic servers', async () =>
  await withTempWorkspace(async ({ root, host }) => {
    await Deno.mkdir(`${root}/.weave`, { recursive: true });
    await Deno.writeTextFile(`${root}/main.ts`, 'const answer = 42;\n');
    await Deno.writeTextFile(`${root}/deno.json`, '{}\n');
    const fakeServerPath = `${root}/fake-lsp.ts`;
    await Deno.writeTextFile(fakeServerPath, fakeLspServerSource);
    await Deno.writeTextFile(
      `${root}/.weave/language-servers.jsonc`,
      JSON.stringify({
        servers: {
          denols: {
            enabled: true,
            toolId: 'deno',
            command: Deno.execPath(),
            args: ['run', '--quiet', fakeServerPath, '--no-publish-diagnostics', '--require-workspace-configuration'],
            languages: ['typescript'],
            rootMarkers: ['deno.json', 'deno.jsonc', 'package.json', '.git'],
            configFiles: ['deno.json', 'deno.jsonc'],
            priority: 1000,
            settings: { require_configuration: true },
          },
        },
      }),
    );

    const session = await host.createSession({
      target: { workspacePath: root },
      path: 'main.ts',
      serverId: 'denols',
    });
    const events: unknown[] = [];
    const send = (event: unknown) => events.push(event);
    await initializeClient(host, 'client-a', session.sessionId, session.rootUri, send);
    await waitForJsonRpcEvent(events, (message) => message.id === 1);
    await didOpen(host, 'client-a', session.sessionId, session.documentUri!, send);

    const diagnostics = await waitForJsonRpcEvent(
      events,
      (message) => message.method === 'textDocument/publishDiagnostics',
    );
    assertEquals((diagnostics.params?.diagnostics as Array<Record<string, unknown>>)[0]?.source, 'fake-pull-lsp');
  }));

Deno.test('PortalLspHost keeps shared runtime alive across client shutdown on file switches', async () =>
  await withTempWorkspace(async ({ root, host }) => {
    await Deno.mkdir(`${root}/.weave`, { recursive: true });
    await Deno.writeTextFile(`${root}/main.ts`, 'const answer = 42;\\n');
    await Deno.writeTextFile(`${root}/env.ts`, 'export const env = "test";\\n');
    const fakeServerPath = `${root}/fake-lsp.ts`;
    await Deno.writeTextFile(fakeServerPath, fakeLspServerSource);
    await Deno.writeTextFile(
      `${root}/.weave/language-servers.jsonc`,
      JSON.stringify({
        servers: {
          fake: {
            enabled: true,
            command: Deno.execPath(),
            args: ['run', '--quiet', fakeServerPath],
            languages: ['typescript'],
            rootMarkers: ['package.json', '.git'],
            priority: 1000,
          },
        },
      }),
    );

    const session = await host.createSession({
      target: { workspacePath: root },
      path: 'main.ts',
      serverId: 'fake',
    });
    const events: unknown[] = [];
    const send = (event: unknown) => events.push(event);
    await host.handleClientMessage('client-a', { type: 'start', sessionId: session.sessionId }, send);
    await host.handleClientMessage('client-a', {
      type: 'jsonrpc',
      sessionId: session.sessionId,
      message: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { rootUri: session.rootUri, capabilities: {} },
      }),
    }, send);
    await host.handleClientMessage('client-a', {
      type: 'jsonrpc',
      sessionId: session.sessionId,
      message: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'shutdown' }),
    }, send);
    await host.handleClientMessage('client-a', {
      type: 'jsonrpc',
      sessionId: session.sessionId,
      message: JSON.stringify({ jsonrpc: '2.0', method: 'exit' }),
    }, send);

    const hover = await host.query({
      target: { workspacePath: root },
      path: 'env.ts',
      serverId: 'fake',
      feature: 'hover',
      line: 0,
      character: 13,
    }) as Record<string, any>;

    assertEquals(hover.ok, true);
    assertStringIncludes(hover.hover.contents.value, 'hover');
  }));
