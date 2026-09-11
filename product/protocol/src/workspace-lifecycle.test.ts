import { test, expect } from 'bun:test';
import { parsePortalRpcParams, parsePortalRpcResult } from './index';

test('workspace close requires a typed confirmation and exact consequence token', () => {
  const input = { hostId: 'host', workspaceId: 'workspace', token: 'token', confirmed: false };
  expect(parsePortalRpcParams('workspace.close', input)).toEqual(input);
  for (const confirmed of [undefined, 'true', 1]) expect(() => parsePortalRpcParams('workspace.close', { ...input, confirmed })).toThrow();
  expect(() => parsePortalRpcParams('workspace.close', { ...input, token: '' })).toThrow();
  const plan = { workspaceId: 'workspace', name: 'Work', token: 'token', terminals: [{ terminalId: 'terminal', title: 'shell', dirty: true }], threads: [] };
  expect(parsePortalRpcResult('workspace.close.preview', { plan })).toEqual({ plan });
  expect(() => parsePortalRpcResult('workspace.close.preview', { plan: { ...plan, terminals: [{ ...plan.terminals[0], dirty: 'false' }] } })).toThrow();
});
