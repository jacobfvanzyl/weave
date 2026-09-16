import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Portal } from '../../portal/src/portal.ts';
import { startPortalServer } from '../../portal/src/server.ts';
import { serveBrowserService } from '../../portal/src/browser-service/service.ts';
import { BrowserServiceClient } from '../../portal/src/browser-service/client.ts';
import { browserDiagnostics } from '../../portal/src/browser-diagnostics.ts';
import { runIPadBrowserAcceptance } from './browser-ipad-acceptance.ts';
import { browserScrollFixture } from './browser-scroll-fixture.ts';

if (process.platform !== 'darwin' || !browserDiagnostics) throw new Error('Run on Mac with WEAVE_BROWSER_DIAGNOSTICS=1');
const root = await mkdtemp('/tmp/weave-browser-scroll-');
const binary = process.env.CEF_BINARY ?? resolve(import.meta.dir, '../../portal/dist/browser-runtime/Weave Browser.app/Contents/MacOS/Weave Browser');
const alpha = process.env.ALPHA_BINARY ?? resolve(import.meta.dir, '../release/Weave Alpha-darwin-arm64/Weave Alpha.app/Contents/MacOS/Weave Alpha');
const ipad = process.env.BROWSER_IPAD_DEVICE;
const address = ipad ? process.env.BROWSER_HOST_ADDRESS : '127.0.0.1';
if (!address) throw new Error('Set BROWSER_HOST_ADDRESS to the Mac LAN/VPN address for iPad acceptance');
const durationMs = Number(process.env.BROWSER_SCROLL_SECONDS ?? 60) * 1000;
if (!(durationMs >= 1000 && durationMs <= 120000)) throw new Error('Benchmark duration must be 1–120 seconds');
process.env.WEAVE_BROWSER_CEF_DIAGNOSTICS_PATH = join(root, 'cef-performance.jsonl');
const fixture = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(browserScrollFixture, { headers: { 'content-type': 'text/html' } }) });
const tls=process.env.BROWSER_TLS_CONFIG ? (await Bun.file(process.env.BROWSER_TLS_CONFIG).json()).tls : undefined;
const owner = await serveBrowserService({ stateDirectory: root, binary: '/unused', cefBinary: binary });
const backend = new BrowserServiceClient(root, '/unused', binary);
const portal = await Portal.open({ stateDirectory: root, displayName: 'Browser scrolling acceptance', listen: { hostname: ipad ? '0.0.0.0' : '127.0.0.1', port: 0 }, ...(tls ? {tls} : {}), allowedOrigins: ['weave://app', 'capacitor://localhost'], executionContexts: [], agents: [] }, { terminalBackend: false, browserBackend: backend });
const server = startPortalServer(portal);
let success = false;
const resources: { at: number; cpuPercent: number; rssKiB: number }[] = [];
let sampling = false;
const resourceTimer = setInterval(() => { void (async () => {
  if (sampling) return; sampling = true;
  try {
    const ps = Bun.spawn(['ps', '-axo', 'pid=,ppid=,%cpu=,rss='], { stdout: 'pipe' });
    const rows = (await new Response(ps.stdout).text()).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    const family = new Set([process.pid]);
    for (let pass = 0; pass < 8; pass++) for (const [pid, parent] of rows) if (family.has(parent!)) family.add(pid!);
    const own = rows.filter(([pid]) => family.has(pid!));
    resources.push({ at: Date.now(), cpuPercent: own.reduce((n, row) => n + row[2]!, 0), rssKiB: own.reduce((n, row) => n + row[3]!, 0) });
    await ps.exited;
  } finally { sampling = false; }
})(); }, 1000);
console.log(`Benchmark evidence: ${root}`);
try {
  await writeFile(join(root, 'input.json'), JSON.stringify({ hostUrl: `${tls ? 'wss' : 'ws'}://${address}:${server.addr.port}`, pairingToken: await portal.security.createPairingToken(), workspaceName: 'Browser', browserHostId:portal.security.hostId, ...(process.env.BROWSER_CLEANUP_HOSTS ? {cleanupHostUrls:JSON.parse(process.env.BROWSER_CLEANUP_HOSTS)} : {}), browserUrl: `http://127.0.0.1:${fixture.port}/`, browserBenchmark: { durationMs, animation: process.env.BROWSER_SCROLL_ANIMATION === '1' } }), { mode: 0o600 });
  if (ipad) await runIPadBrowserAcceptance(root, ipad, durationMs);
  else {
  const app = Bun.spawn([alpha, '--host-acceptance', ...(process.env.BROWSER_DEVICE_SCALE ? [`--force-device-scale-factor=${process.env.BROWSER_DEVICE_SCALE}`] : [])], { env: { ...process.env, WEAVE_ALPHA_ACCEPTANCE_DIR: root, WEAVE_BROWSER_FIXTURE_MARKERS: '1', WEAVE_BROWSER_DIAGNOSTICS_PATH: join(root, 'native-performance.json') }, stdout: Bun.file(join(root, 'electron.log')), stderr: Bun.file(join(root, 'electron-error.log')) });
  let profiles: Promise<unknown>[] = [];
  const profiling=setTimeout(() => { void (async () => {
    const ps=Bun.spawn(['ps','-axo','pid=,command='],{stdout:'pipe'});
    const rows=(await new Response(ps.stdout).text()).split('\n');
    const host=rows.find(row=>row.includes('/MacOS/Weave Browser ') && row.includes(root) && !row.includes('--type='));
    for (const [name,pid] of [['alpha',app.pid],['cef',host ? Number(host.trim().split(/\s+/)[0]) : 0]] as const) {
      if (!pid) continue;
      const sample=Bun.spawn(['sample',String(pid),'10','1','-file',join(root,`${name}-sample.txt`)],{stdout:'ignore',stderr:'ignore'});
      profiles.push(sample.exited);
    }
  })(); },10000);
  const timer = setTimeout(() => app.kill('SIGTERM'), durationMs + 90000);
  const code = await app.exited; clearTimeout(timer); clearTimeout(profiling); await Promise.allSettled(profiles);
  if (code !== 0) throw new Error(`Alpha scrolling acceptance failed (${code})`);
  }
  await writeFile(join(root,'route.json'),JSON.stringify({ route: ipad ? 'iPad to Mac Host over LAN/VPN; software event capture to native layer submission, not physical scanout' : 'Mac loopback; software event capture to native layer submission, not physical scanout', address, scheme:tls?'wss':'ws', responsiveData:process.env.WEAVE_BROWSER_RESPONSIVE_DATA==='1', encoding:process.env.WEAVE_BROWSER_RFB_ENCODING ?? 'zrle', gpu:process.env.WEAVE_BROWSER_GPU === '1' }));
  const { pages } = await backend.managedPage('page.list', {}), page = pages[0];
  if (!page) throw new Error('No Browser page was created');
  const command = (method: string, args: Record<string, unknown>) => backend.managedPage('page.cdp', { pageId: page.pageId, generation: page.generation, arguments: { method, arguments: args } });
  const pageResult = (await command('Runtime.evaluate', { expression: 'JSON.stringify({scrollY,frames:fixtureFrames,width:innerWidth,height:innerHeight,dpr:devicePixelRatio})', returnByValue: true })).result.value;
  await writeFile(join(root, 'portal-performance.json'), JSON.stringify(browserDiagnostics));
  await writeFile(join(root, 'resources.json'), JSON.stringify(resources));
  await writeFile(join(root, 'page-result.json'), pageResult);
  success = true;
  console.log(JSON.stringify({ success, root, page: JSON.parse(pageResult) }));
} finally {
  clearInterval(resourceTimer);
  await server.shutdown(); await portal.close(); await owner.close(); await fixture.stop(true);
  await rm(join(root, 'input.json'), { force: true });
  console.log(`Evidence: ${root}; success=${success}`);
}
