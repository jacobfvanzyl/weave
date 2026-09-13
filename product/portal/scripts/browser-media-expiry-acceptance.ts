import { mkdtemp, rm } from 'node:fs/promises';
import { BrowserServiceClient } from '../src/browser-service/client.ts';
import { serveBrowserService } from '../src/browser-service/service.ts';
const binary = process.env.CHROME_BINARY;
if (!binary) throw new Error('Set CHROME_BINARY explicitly');
const state = await mkdtemp('/tmp/weave-browser-expiry-');
const service = await serveBrowserService({ stateDirectory: state, binary });
const client = new BrowserServiceClient(state);
const fixture = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<h1>Grant expiry fixture</h1><script>window.ticks=0;setInterval(()=>ticks++,20)</script>', { headers: { 'content-type': 'text/html' } }) });
try {
  const workspaceId = 'expiry';
  const { tab } = await client.browser('browser.tab.create', { workspaceId, url: `http://127.0.0.1:${fixture.port}` });
  const { grant } = await client.browser('browser.view.attach', { workspaceId, tabId: tab.tabId, mode: 'observe' });
  let offered = false;
  while (!offered) offered = (await client.events(workspaceId, grant.viewId)).some(event => event.message.type === 'offer');
  const browser = await client.openWorkspace(workspaceId);
  const send = (method: string, params: object = {}, session?: string) => client.send(workspaceId, browser.generation, method, params, session);
  const { targetInfos } = await send('Target.getTargets');
  const offscreen = targetInfos.find((target: any) => target.url.endsWith('/offscreen.html'));
  const { sessionId } = await send('Target.attachToTarget', { targetId: offscreen.targetId, flatten: true });
  const inspect = async () => (await send('Runtime.evaluate', { expression: '({peers:peers.size,captures:captures.size})', returnByValue: true }, sessionId)).result.value;
  const before = await inspect();
  await Bun.sleep(Math.max(0, grant.expiresAt - Date.now() + 1000));
  let expired = false;
  try { await client.renew(workspaceId, grant.viewId); } catch { expired = true; }
  const after = await inspect();
  const available = (await client.openWorkspace(workspaceId)).available;
  if (!expired || before.peers !== 1 || after.peers !== 0 || after.captures !== 0 || !available) throw new Error('Media grant expiry failed');
  console.log(JSON.stringify({ passed: true, platform: process.platform, browser: browser.version, expired, before, after, browserAvailable: available, expiryMs: 30000 }));
} finally {
  client.dispose(); fixture.stop(true); await service.close(); await rm(state, { recursive: true, force: true });
}
