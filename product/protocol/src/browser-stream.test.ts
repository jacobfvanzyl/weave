import { expect, test } from 'bun:test';
import { BROWSER_RPC_METHODS, parsePortalRpcParams, parsePortalRpcResult, parseBrowserNotification } from './index.ts';

test('browser contracts bind views to Workspaces and retain only supported signaling', () => {
  expect(BROWSER_RPC_METHODS).toContain('browser.view.attach');
  expect(parsePortalRpcParams('browser.view.attach', { workspaceId: 'w', tabId: 't', mode: 'observe', clientId: 'forged' })).toEqual({ workspaceId: 'w', tabId: 't', mode: 'observe' });
  expect(parsePortalRpcParams('browser.view.signal', { workspaceId: 'w', viewId: 'v', signal: { type: 'ice', peer: 'p', candidate: { candidate: '', sdpMid: null, sdpMLineIndex: 0 } } })).toEqual({ workspaceId: 'w', viewId: 'v', signal: { type: 'ice', peer: 'p', candidate: { candidate: '', sdpMid: null, sdpMLineIndex: 0 } } });
  expect(parsePortalRpcResult('browser.view.attach', { grant: { workspaceId: 'w', tabId: 't', viewId: 'v', expiresAt: 100 } })).toEqual({ grant: { workspaceId: 'w', tabId: 't', viewId: 'v', expiresAt: 100 } });
  expect(parseBrowserNotification({ workspaceId: 'w', viewId: 'v', message: { type: 'reset', tab: 't', peer: 'p', generation: 2 } }).message.type).toBe('reset');
});
test('browser boundaries reject privileged URL schemes, unbounded media and invalid geometry', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://extensions', 'data:text/html,hello']) expect(() => parsePortalRpcParams('browser.tab.create', { workspaceId: 'w', url })).toThrow();
  for (const width of [NaN, Infinity, 0, 3000, 640.5]) expect(() => parsePortalRpcParams('browser.view.focus', { workspaceId: 'w', viewId: 'v', width, height: 600 })).toThrow();
  expect(() => parsePortalRpcParams('browser.view.signal', { workspaceId: 'w', viewId: 'v', signal: { type: 'offer', peer: 'p', sdp: 'x' } })).toThrow();
  expect(() => parsePortalRpcParams('browser.view.signal', { workspaceId: 'w', viewId: 'v', signal: { type: 'answer', peer: 'p', sdp: 'x'.repeat(128 * 1024 + 1) } })).toThrow();
  expect(() => parsePortalRpcParams('browser.view.click', { workspaceId: 'w', viewId: 'v', generation: 1, x: -1, y: 10 })).toThrow();
});
