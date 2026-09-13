import { expect, test } from 'bun:test';
import { parseBrowserPage, parseBrowserPageRpcParams, parseBrowserPageRpcResult, PORTAL_BROWSER_RFB_PATH } from './browser-pages.ts';
import { parsePortalAuthChallenge, parsePortalRpcParams, portalAuthChallengePayload } from './index.ts';
const profileId = crypto.randomUUID(), pageId = crypto.randomUUID(), generation = crypto.randomUUID(), viewId = crypto.randomUUID();
test('Browser page wire summaries strip native paths and require a live runtime generation', () => {
  const page = { pageId, profileId, generation, title: 'Page', url: 'https://example.com/', available: true, width: 800, height: 600, rfbSocket: '/private/socket' };
  expect(parseBrowserPage(page)).not.toHaveProperty('rfbSocket');
  expect(() => parseBrowserPage({ ...page, generation: undefined })).toThrow();
  expect(parseBrowserPage({ ...page, available: false })).not.toHaveProperty('generation');
  expect(() => parseBrowserPageRpcResult('browser.page.list', { pages: [page, page] })).toThrow('Duplicate');
});
test('only bounded viewports and explicit input methods cross the public browser boundary', () => {
  expect(() => parseBrowserPageRpcParams('browser.page.view.focus', { viewId, width: 4096, height: 4096 })).toThrow();
  expect(() => parseBrowserPageRpcParams('browser.page.view.resize', { viewId, width: 800, height: 600 })).toThrow();
  expect(() => parseBrowserPageRpcParams('browser.page.view.input', { viewId, focusEpoch: 1, method: 'Runtime.evaluate', arguments: { expression: '1' } })).toThrow();
  expect(() => parseBrowserPageRpcParams('browser.page.view.input', { viewId, focusEpoch: 1, method: 'Input.insertText', arguments: { text: 'x'.repeat(32769) } })).toThrow();
  expect(parsePortalRpcParams('browser.page.view.focus', { viewId, width: 800, height: 600 })).toEqual({ viewId, width: 800, height: 600 });
});
test('navigation rejects credentials and privileged schemes; RFB authentication has its own audience', () => {
  for (const url of ['file:///etc/passwd', 'about:config', 'https://user:pass@example.com']) expect(() => parseBrowserPageRpcParams('browser.page.navigate', { pageId, profileId, generation, url })).toThrow();
  const challenge = { type: 'weave.portal.auth.challenge', challengeId: 'fixture', hostId: 'host', nonce: 'nonce', audience: PORTAL_BROWSER_RFB_PATH, origin: '-', expiresAt: new Date().toISOString() };
  expect(parsePortalAuthChallenge(challenge).audience).toBe(PORTAL_BROWSER_RFB_PATH);
  expect(portalAuthChallengePayload(parsePortalAuthChallenge(challenge))).toContain('/browser/rfb');
});
