import { WORKSPACE_FILE_RPC_METHODS, WORKSPACE_FILE_WATCH_EVENT_METHOD } from '@weave/product-protocol';
import { pairPortalCredential, required, RpcResponseError, RpcSocket, waitFor } from './rpc-client.ts';

const baseUrl = required('PORTAL_URL').replace(/\/$/, '');
const credential = await pairPortalCredential(baseUrl, required('PORTAL_PAIRING_TOKEN'), 'Filesystem acceptance');
const executionContextId = required('PORTAL_WORKSPACE_ID');
const marker = process.env['PORTAL_FILESYSTEM_ACCEPTANCE_MARKER']?.trim() || `WVE42_${crypto.randomUUID()}`;
const fixture = `.weave-acceptance/wve-42-${crypto.randomUUID()}`;
const originalPath = `${fixture}/original.txt`;
const movedPath = `${fixture}/moved.txt`;
const observedPath = `${fixture}/observed.txt`;
const rpc = await RpcSocket.open(`${baseUrl}/rpc`, credential);
let fixtureCreated = false;

try {
  const capabilities = await rpc.request('portal.capabilities') as { capabilities: string[] };
  for (const capability of WORKSPACE_FILE_RPC_METHODS) {
    if (!capabilities.capabilities.includes(capability)) throw new Error(`Portal does not advertise ${capability}.`);
  }

  await rpc.request('context.directory.create', { executionContextId, path: fixture });
  fixtureCreated = true;
  const created = await rpc.request('context.file.write', {
    executionContextId,
    path: originalPath,
    content: marker,
    expectedContentHash: null,
  }) as { contentHash: string };
  const read = await rpc.request('context.file.read', { executionContextId, path: originalPath }) as {
    content: string;
    contentHash: string;
  };
  if (read.content !== marker || read.contentHash !== created.contentHash) {
    throw new Error('Portal did not read back the accepted Workspace file content.');
  }
  const hashed = await rpc.request('context.file.hash', { executionContextId, path: originalPath }) as {
    contentHash: string;
  };
  if (hashed.contentHash !== created.contentHash) throw new Error('Portal returned an inconsistent content hash.');

  const listed = await rpc.request('context.file.list', { executionContextId, path: fixture }) as {
    entries: Array<{ path: string }>;
  };
  if (!listed.entries.some((entry) => entry.path === originalPath)) {
    throw new Error('Portal did not list the created Workspace file.');
  }

  const updatedContent = `${marker}_UPDATED`;
  const updated = await rpc.request('context.file.write', {
    executionContextId,
    path: originalPath,
    content: updatedContent,
    expectedContentHash: created.contentHash,
  }) as { contentHash: string };

  let stale: unknown;
  try {
    await rpc.request('context.file.write', {
      executionContextId,
      path: originalPath,
      content: 'MUST_NOT_OVERWRITE',
      expectedContentHash: created.contentHash,
    });
  } catch (cause) {
    stale = cause;
  }
  if (
    !(stale instanceof RpcResponseError) || stale.code !== -32010 ||
    (stale.data as { code?: unknown } | undefined)?.code !== 'STALE_CONTENT'
  ) {
    throw new Error('Portal did not reject a stale conditional write.');
  }

  const afterStale = await rpc.request('context.file.hash', { executionContextId, path: originalPath }) as {
    contentHash: string;
  };
  if (afterStale.contentHash !== updated.contentHash) throw new Error('A stale write changed the Workspace file.');

  await rpc.request('context.file.move', { executionContextId, fromPath: originalPath, toPath: movedPath });
  const search = await rpc.request('context.file.search', {
    executionContextId,
    path: fixture,
    query: updatedContent,
    scope: 'content',
    limit: 10,
  }) as { matches: Array<{ path: string }> };
  if (!search.matches.some((match) => match.path === movedPath)) {
    throw new Error('Portal search did not find the marker.');
  }

  const watch = await rpc.request('context.file.watch.start', { executionContextId, paths: [fixture] }) as {
    subscriptionId: string;
  };
  await rpc.request('context.file.watch.update', { subscriptionId: watch.subscriptionId, paths: [fixture] });
  await rpc.request('context.file.write', {
    executionContextId,
    path: observedPath,
    content: 'observed',
    expectedContentHash: null,
  });
  await waitFor(() =>
    rpc.notifications.some((message) =>
      message.method === WORKSPACE_FILE_WATCH_EVENT_METHOD && JSON.stringify(message.params).includes(observedPath)
    )
  );
  await rpc.request('context.file.watch.stop', { subscriptionId: watch.subscriptionId });
  await rpc.request('context.file.delete', { executionContextId, path: observedPath });

  let traversal: unknown;
  try {
    await rpc.request('context.file.read', { executionContextId, path: '../outside.txt' });
  } catch (cause) {
    traversal = cause;
  }
  if (
    !(traversal instanceof RpcResponseError) || traversal.code !== -32010 ||
    (traversal.data as { code?: unknown } | undefined)?.code !== 'INVALID_PATH'
  ) {
    throw new Error('Portal did not reject Workspace path traversal.');
  }

  console.log(JSON.stringify({ ok: true, executionContextId, fixture, marker }));
} finally {
  if (fixtureCreated) await rpc.request('context.file.delete', { executionContextId, path: fixture, recursive: true });
  await rpc.request('credential.revoke').catch(() => undefined);
  rpc.close();
}
