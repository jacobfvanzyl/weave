import type { JsonRpcMessage } from '../src/json-rpc.ts';
import { pairPortalCredential, required, RpcResponseError, RpcSocket, waitFor } from './rpc-client.ts';

const notificationText = (messages: JsonRpcMessage[]) =>
  messages.map((message) => {
    const params = message.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) return '';
    const update = (params as { update?: unknown }).update;
    if (!update || typeof update !== 'object' || Array.isArray(update)) return '';
    const content = (update as { content?: unknown }).content;
    if (!content || typeof content !== 'object' || Array.isArray(content)) return '';
    const text = (content as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  }).join('');

const baseUrl = required('PORTAL_URL').replace(/\/$/, '');
const credential = await pairPortalCredential(baseUrl, required('PORTAL_PAIRING_TOKEN'), 'Portal acceptance');
const executionContextId = required('PORTAL_WORKSPACE_ID');
const agentId = required('PORTAL_AGENT_ID');
const marker = required('PORTAL_ACCEPTANCE_MARKER');
const recovery = process.env['PORTAL_ACCEPTANCE_RECOVERY'] === 'true';
const existingThreadId = process.env['PORTAL_ACCEPTANCE_THREAD_ID']?.trim();
const expectedGeneration = process.env['PORTAL_ACCEPTANCE_EXPECTED_GENERATION']?.trim();
const rpc = await RpcSocket.open(`${baseUrl}/rpc`, credential);
try {
  const thread = existingThreadId
    ? ((await rpc.request('thread.list') as { threads: Array<{ threadId: string; acpSessionId: string }> }).threads
      .find((candidate) => candidate.threadId === existingThreadId))
    : (await rpc.request('thread.create', { executionContextId, agentId, title: `Acceptance ${marker}` }) as {
      thread: { threadId: string; acpSessionId: string };
    }).thread;
  if (!thread) throw new Error(`Acceptance Thread is unavailable: ${existingThreadId}`);
  const attachment = await rpc.request('thread.attach', { threadId: thread.threadId }) as {
    thread: { threadId: string; acpSessionId: string };
    connection: { path: string; threadId: string; cwd: string };
  };
  const attachedThread = attachment.thread;
  const acp = await RpcSocket.open(
    `${baseUrl}${attachment.connection.path}?threadId=${encodeURIComponent(attachment.connection.threadId)}`,
    credential,
  );
  try {
    const initialized = await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    if (recovery && !JSON.stringify(initialized).includes('_weave.dev/runtime/state')) {
      throw new Error('Portal did not advertise runtime recovery.');
    }
    await acp.request('session/load', {
      sessionId: attachedThread.acpSessionId,
      cwd: attachment.connection.cwd,
      mcpServers: [],
      ...(recovery ? { _meta: { 'weave.dev/threadEvents': { afterSequence: 0 } } } : {}),
    });
    const baseSequence = recovery
      ? Number(
        (acp.notifications.find((message) => message.method === '_weave.dev/thread_events/sync')?.params as {
          lastSequence?: unknown;
        } | undefined)?.lastSequence,
      )
      : 0;
    if (recovery && !Number.isInteger(baseSequence)) throw new Error('Portal did not establish a replay cursor.');
    await acp.request('session/prompt', {
      sessionId: attachedThread.acpSessionId,
      prompt: [{ type: 'text', text: `Reply with exactly ${marker}` }],
    });
    if (!notificationText(acp.notifications).includes(marker)) {
      throw new Error(`Agent transcript did not contain ${marker}.`);
    }
    if (recovery) {
      let uncertain: unknown;
      try {
        await acp.request('session/prompt', {
          sessionId: attachedThread.acpSessionId,
          prompt: [{ type: 'text', text: 'CRASH_WITH_STALE_REMOTE_ACCEPTANCE' }],
        });
      } catch (cause) {
        uncertain = cause;
      }
      if (
        !(uncertain instanceof RpcResponseError) || uncertain.code !== -32050 ||
        (uncertain.data as { code?: unknown } | undefined)?.code !== 'PROMPT_UNCERTAIN'
      ) {
        throw new Error('Interrupted prompt did not return PROMPT_UNCERTAIN.');
      }
      if (
        expectedGeneration &&
        Number((uncertain.data as { generation?: unknown }).generation) !== Number(expectedGeneration)
      ) {
        throw new Error(`Interrupted prompt used an unexpected runtime generation: ${JSON.stringify(uncertain.data)}`);
      }
      await waitFor(() =>
        acp.notifications.some((message) =>
          message.method === '_weave.dev/runtime/state' &&
          (message.params as { code?: unknown }).code === 'RECOVERED'
        )
      );
      await new Promise((resolve) => setTimeout(resolve, 125));
      if (acp.notifications.some((message) => JSON.stringify(message).includes('OBSOLETE_PROVIDER_EVENT'))) {
        throw new Error('An obsolete provider generation reached the client.');
      }

      const recoveredMarker = `${marker}_RECOVERED`;
      await acp.request('session/prompt', {
        sessionId: attachedThread.acpSessionId,
        prompt: [{ type: 'text', text: recoveredMarker }],
      });
      if (!notificationText(acp.notifications).includes(recoveredMarker)) {
        throw new Error('Fresh prompt did not complete after provider recovery.');
      }

      const reattached = await RpcSocket.open(
        `${baseUrl}${attachment.connection.path}?threadId=${encodeURIComponent(attachment.connection.threadId)}`,
        credential,
      );
      try {
        await reattached.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
        await reattached.request('session/load', {
          sessionId: attachedThread.acpSessionId,
          cwd: attachment.connection.cwd,
          mcpServers: [],
          _meta: { 'weave.dev/threadEvents': { afterSequence: baseSequence + 3 } },
        });
        if (!notificationText(reattached.notifications).includes(recoveredMarker)) {
          throw new Error('Cursor reattachment did not replay the recovered turn.');
        }
      } finally {
        reattached.close();
      }
    }
    console.log(JSON.stringify({ ok: true, threadId: thread.threadId, marker, recovery }));
  } finally {
    acp.close();
  }
} finally {
  await rpc.request('credential.revoke').catch(() => undefined);
  rpc.close();
}
