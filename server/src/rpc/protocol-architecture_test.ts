import { assertEquals } from 'jsr:@std/assert@1';
import { portalToolNames, rpcRequestMethods } from '@weave/protocol';

const workspaceFileActions = [
  'list',
  'read',
  'hash',
  'diffPreview',
  'write',
  'mkdir',
  'move',
  'delete',
  'index',
  'upload',
] as const;
const terminalActions = ['snapshot', 'list', 'create', 'attach', 'input', 'resize', 'close', 'detach'] as const;
const watchActions = ['start', 'update', 'stop'] as const;
const lspActions = ['start', 'send', 'close'] as const;
const jupyterActions = ['execute', 'close'] as const;

const literalRegistrations = (source: string, receiver: 'router' | 'connection') =>
  [...source.matchAll(new RegExp(`${receiver}\\.register(?:Validated)?\\(\\s*['\"]([^'\"]+)['\"]`, 'g'))]
    .map((match) => match[1]);

Deno.test('protocol v2 request matrix matches server and Portal registrations', async () => {
  const serverSources = await Promise.all([
    Deno.readTextFile(new URL('./methods.ts', import.meta.url)),
    Deno.readTextFile(new URL('../modules/code/rpc.ts', import.meta.url)),
    Deno.readTextFile(new URL('../modules/workspace-composition/rpc.ts', import.meta.url)),
  ]);
  const serverMethods = new Set(serverSources.flatMap((source) => literalRegistrations(source, 'router')));
  for (const action of workspaceFileActions) serverMethods.add(`workspaceFile.${action}`);

  const expectedClientMethods = rpcRequestMethods('client', 'server').filter((method) => method !== 'initialize');
  assertEquals([...serverMethods].sort(), [...expectedClientMethods].sort());
  const expectedPortalToServer = rpcRequestMethods('portal', 'server').filter((method) => method !== 'initialize');
  assertEquals(expectedPortalToServer.every((method) => serverMethods.has(method)), true);

  const portalSource = await Deno.readTextFile(new URL('../../../portal/src/main.ts', import.meta.url));
  const portalMethods = new Set(literalRegistrations(portalSource, 'connection'));
  for (const action of workspaceFileActions) portalMethods.add(`portal.workspaceFile.${action}`);
  for (const action of terminalActions) portalMethods.add(`portal.terminal.${action}`);
  for (const action of watchActions) portalMethods.add(`portal.workspaceFile.watch.${action}`);
  for (const action of lspActions) portalMethods.add(`portal.lsp.${action}`);
  for (const action of jupyterActions) portalMethods.add(`portal.jupyter.${action}`);
  assertEquals([...portalMethods].sort(), [...rpcRequestMethods('server', 'portal')].sort());

  const portalToolHandlers = new Set(
    [...portalSource.matchAll(/portalHandler\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]),
  );
  assertEquals([...portalToolHandlers].sort(), [...portalToolNames].sort());
});

const sourceRoots = [
  new URL('../../../packages/client/src/', import.meta.url),
  new URL('../../../desktop/src/', import.meta.url),
  new URL('../../', import.meta.url),
  new URL('../../../portal/src/', import.meta.url),
];

const sourceFiles = async (root: URL): Promise<URL[]> => {
  const files: URL[] = [];
  for await (const entry of Deno.readDir(root)) {
    const url = new URL(entry.name + (entry.isDirectory ? '/' : ''), root);
    if (entry.isDirectory) files.push(...await sourceFiles(url));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('_test.ts')) files.push(url);
  }
  return files;
};

Deno.test('application layers contain no generic RPC result assertions or duplicate canonical DTO objects', async () => {
  const violations: string[] = [];
  const duplicateDtoPattern =
    /export\s+type\s+(Workspace|Project|WorkspaceGitState|EditorEntry|EditorFile|TerminalWindowRecord|TerminalHostEvent|LspSessionResult|CoppermindJupyterStatusResult|ClientToolConnection|WorkflowDefinition|LiveEditorContextSnapshot|WeaveNotificationEvent)\s*=\s*\{/;
  for (const root of sourceRoots) {
    for (const file of await sourceFiles(root)) {
      const source = await Deno.readTextFile(file);
      if (
        /rpcRequest\s*</.test(source) ||
        /\.request\s*</.test(source) ||
        /\bas\s+RpcRequestResult\b/.test(source)
      ) {
        violations.push(`${file.pathname}: generic RPC result assertion`);
      }
      if (duplicateDtoPattern.test(source)) violations.push(`${file.pathname}: duplicate canonical DTO`);
    }
  }
  assertEquals(violations, []);
});
