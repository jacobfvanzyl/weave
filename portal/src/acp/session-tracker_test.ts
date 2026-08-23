import { assertEquals } from 'jsr:@std/assert@1';
import type { JsonRpcMessage } from '@weave/protocol';
import { AcpSessionTracker } from './session-tracker.ts';
import type { HostThreadRecord, ThreadCatalog } from './thread-catalog.ts';

Deno.test('ACP Session tracker records only successful lifecycle responses', async () => {
  const calls: string[] = [];
  const catalog: ThreadCatalog = {
    upsertAcpSession: (input) => {
      calls.push(`upsert:${input.acpSessionId}:${input.workspaceId}:${input.creatorPrincipalId}`);
      return Promise.resolve({} as HostThreadRecord);
    },
    touchAcpSession: (_agentId, _workspaceId, sessionId) => {
      calls.push(`touch:${sessionId}`);
      return Promise.resolve();
    },
    setAcpSessionStatus: (_agentId, _workspaceId, sessionId, status) => {
      calls.push(`status:${sessionId}:${status}`);
      return Promise.resolve();
    },
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(undefined),
  };
  const tracker = new AcpSessionTracker(catalog, {
    agentId: 'codex',
    workspaceId: 'odin',
    principalId: 'local',
  });
  const observe = (message: unknown) => tracker.observeClientMessage(message as JsonRpcMessage);
  const respond = (message: unknown) => tracker.observeAgentMessage(message as JsonRpcMessage);

  observe({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/workspace', mcpServers: [] } });
  await respond({ jsonrpc: '2.0', id: 1, result: { sessionId: 'session-1' } });
  observe({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [] } });
  await respond({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update: {} } });
  await respond({ jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn' } });
  observe({ jsonrpc: '2.0', id: 3, method: 'session/close', params: { sessionId: 'session-1' } });
  await respond({ jsonrpc: '2.0', id: 3, result: null });
  observe({ jsonrpc: '2.0', id: 4, method: 'session/load', params: { sessionId: 'missing', cwd: '/workspace' } });
  await respond({ jsonrpc: '2.0', id: 4, error: { code: -32000, message: 'nope' } });

  assertEquals(calls, [
    'upsert:session-1:odin:local',
    'touch:session-1',
    'status:session-1:closed',
  ]);
});
