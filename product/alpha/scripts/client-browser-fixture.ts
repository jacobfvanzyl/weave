/** WVE-80 deterministic browser capability fixture. No user accounts or Host state. */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
export function startClientBrowserFixture(port = 43187, evidence?: string) {
  const reports: unknown[] = [];
  const requests: { path: string; method: string; cookie: boolean }[] = [];
  let evidenceWriteError: string | undefined;
  const save = async () => {
    if (!evidence) return;
    try {
      await mkdir(evidence, { recursive: true });
      await Bun.write(join(evidence, 'fixture.json'), JSON.stringify({ reports, requests }, null, 2));
      evidenceWriteError = undefined;
    } catch (error) {
      // Evidence storage must not turn successful fixture endpoints into HTTP 500s.
      const message = String(error);
      if (message !== evidenceWriteError) console.error('Fixture evidence unavailable:', message);
      evidenceWriteError = message;
    }
  };
  const cert = process.env.WEAVE_CLIENT_BROWSER_TLS_CERT, key = process.env.WEAVE_CLIENT_BROWSER_TLS_KEY;
  if (Boolean(cert) !== Boolean(key)) throw new Error('Both fixture TLS certificate and key are required.');
  const server = Bun.serve({ hostname: process.env.WEAVE_CLIENT_BROWSER_BIND ?? '0.0.0.0', port, maxRequestBodySize: 16384,
    ...(cert && key ? { tls: { cert: Bun.file(cert), key: Bun.file(key) } } : {}), async fetch(request) {
    const url = new URL(request.url);
    requests.push({ path: url.pathname, method: request.method, cookie: request.headers.get('cookie')?.includes('fixture=ok') ?? false });
    if (url.pathname === '/report' && request.method === 'POST') {
      if (Number(request.headers.get('content-length') ?? 0) > 16384) return new Response('Too large', { status: 413 });
      reports.push(await request.json()); await save(); return new Response('ok');
    }
    await save();
    if (url.pathname === '/health') return Response.json({ ok: !evidenceWriteError, evidenceWriteError });
    if (url.pathname === '/upload' && request.method === 'POST') {
      const form = await request.formData(); const file = form.get('file');
      if (!(file instanceof File)) return new Response('No file', { status: 400 });
      const hash = new Bun.CryptoHasher('sha256').update(await file.arrayBuffer()).digest('hex');
      const result = { name: file.name, size: file.size, sha256: hash };
      reports.push({ kind: 'upload-received', value: result }); await save(); return Response.json(result);
    }
    if (url.pathname === '/offline-fixture') return new Response('network-response');
    if (url.pathname === '/slow-download') {
      let timer: ReturnType<typeof setInterval> | undefined;
      let chunks = 0;
      const stream = new ReadableStream({
        start(controller) { timer = setInterval(() => { controller.enqueue(new Uint8Array(65536).fill(65)); if (++chunks === 200) { clearInterval(timer); controller.close(); } }, 100); },
        cancel() { clearInterval(timer); },
      });
      return new Response(stream, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(65536 * 200), 'Content-Disposition': 'attachment; filename="weave-slow.bin"' } });
    }
    if (url.pathname === '/download' || url.pathname === '/authenticated-download') {
      if (url.pathname.startsWith('/authenticated') && !request.headers.get('cookie')?.includes('fixture=ok')) return new Response('No session cookie', { status: 401 });
      return new Response('WVE-80 downloaded fixture\n', { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="weave-fixture.txt"' } });
    }
    if (url.pathname === '/sw.js') return new Response("self.addEventListener('install',e=>e.waitUntil(caches.open('wve80').then(c=>c.put('/offline-fixture',new Response('cached-response'))).then(()=>self.skipWaiting())));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/offline-fixture')e.respondWith(caches.match('/offline-fixture'))});", { headers: { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/' } });
    if (url.pathname === '/popup') {
      const body = request.method === 'POST' ? await request.text() : '';
      return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Popup callback</title><style>body{font:18px system-ui;padding:20px}button{font:inherit;padding:12px}</style><h1>Popup callback</h1><p id="status"></p><script>const result={kind:'popup-callback',method:${JSON.stringify(request.method)},body:${JSON.stringify(body)},cookie:document.cookie.includes('fixture=ok')};if(opener){opener.postMessage(result,location.origin);document.querySelector('#status').textContent='Opener preserved — '+JSON.stringify(result);}else document.querySelector('#status').textContent='No opener — '+JSON.stringify(result);fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...result,opener:!!opener})});</script><button onclick="window.close()">Close popup</button>`, { headers: { 'Content-Type': 'text/html' } });
    }
    const pane = url.searchParams.get('pane') === 'right' ? 'right' : 'left';
    return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Browser fixture ${pane}</title>
<style>body{font:17px system-ui;margin:24px;line-height:1.5;color:#17202a;background:#f4f7fb}button,a,input{font:inherit;margin:6px 4px;padding:8px}button{cursor:pointer}section{margin:20px 0;padding:14px;border:1px solid #b7c2d0;border-radius:8px}pre{white-space:pre-wrap;font-size:13px}input{max-width:85%}</style>
<h1>Native browser · ${pane}</h1><p>Select this text, scroll, and type below. Each page owns its own state.</p>
<input id="entry" aria-label="Fixture text" placeholder="Type here" autocomplete="off"><button onclick="report('counter',++counter)">Increment</button>
<button onclick="report('retained-state',document.querySelector('#entry').value)">Check retained state</button>
<a href="/?pane=${pane}&next=1">Navigate within this pane</a>
<section><h2>Popup semantics</h2><button onclick="const p=window.open('/popup','_blank');report('window-open',!!p)">Open popup</button><a target="_blank" href="/popup">Target blank</a><form action="/popup" method="post" target="_blank" rel="opener"><input type="hidden" name="proof" value="wve80-post-body"><button>POST popup</button></form><button onclick="const p=window.open('about:blank','_blank');report('blank-open',!!p);if(p)setTimeout(()=>p.location='/popup?delayed=1',250)">Delayed popup</button></section>
<section><h2>Downloads</h2><a href="/slow-download">Slow download</a><a href="/download">Attachment download</a><a href="/authenticated-download">Authenticated download</a><button onclick="report('blob-started',true);const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['WVE-80 blob download'],{type:'text/plain'}));a.download='weave-blob.txt';a.click();setTimeout(()=>window.URL.revokeObjectURL(a.href),30000);report('blob-requested',true)">Blob download</button></section>
<section><h2>Device and app capabilities</h2><input type="file" multiple aria-label="Upload files" onchange="report('files',Array.from(this.files).map(f=>({name:f.name,size:f.size})));if(this.files[0]){const f=new FormData();f.append('file',this.files[0]);fetch('/upload',{method:'POST',body:f}).then(r=>r.json()).then(v=>report('upload',v))}"><button onclick="navigator.mediaDevices.getUserMedia({audio:true,video:true}).then(s=>{report('media','granted');setTimeout(()=>s.getTracks().forEach(t=>t.stop()),3000)}).catch(e=>report('media',e.name))">Camera and microphone</button><button onclick="probe()">Probe web APIs</button></section>
<section><h2>Website dialogs</h2><button onclick="alert('Fixture alert');report('alert',true)">Show alert</button><button onclick="report('confirm',confirm('Confirm fixture action?'))">Show confirm</button><button onclick="report('prompt',prompt('Enter fixture text','sample'))">Show prompt</button></section><pre id="result"></pre><div style="height:400px">Scroll area</div><p>End of ${pane} page</p>
<script>let counter=0;const identity=crypto.randomUUID?.()||Math.random().toString(36);document.cookie='fixture=ok; SameSite=Lax; path=/';
function report(kind,value){const item={pane:${JSON.stringify(pane)},identity,kind,value};document.querySelector('#result').textContent=JSON.stringify(item,null,2);window.webkit?.messageHandlers?.weaveClientBrowserProbe?.postMessage(JSON.stringify(item));fetch('/report',{method:'POST',body:JSON.stringify(item),headers:{'Content-Type':'application/json'}}).catch(()=>{});}
window.addEventListener('error',e=>report('script-error',e.message));window.addEventListener('message',e=>{if(e.origin===location.origin)report('message',e.data)});document.querySelector('#entry').addEventListener('input',e=>report('input',e.target.value));
async function probe(){if(typeof PublicKeyCredential!=='undefined')report('passkey-availability',{platform:await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(),conditional:await PublicKeyCredential.isConditionalMediationAvailable?.()});report('capabilities',{secure:isSecureContext,serviceWorker:'serviceWorker'in navigator,passkeys:typeof PublicKeyCredential!=='undefined',media:!!navigator.mediaDevices?.getUserMedia,screenShare:!!navigator.mediaDevices?.getDisplayMedia,webgpu:!!navigator.gpu});try{const reg=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;report('service-worker','registered');if(!navigator.serviceWorker.controller)await Promise.race([new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true})),new Promise(r=>setTimeout(r,3000))]);report('worker-cache',await (await fetch('/offline-fixture')).text())}catch(e){report('service-worker',e.name+': '+e.message)}}report('loaded',{path:location.pathname,search:location.search});probe();</script>`, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
  }});
  return { server, reports, requests };
}
if (import.meta.main) {
  const { server } = startClientBrowserFixture(Number(process.env.PORT ?? 43187), process.env.WEAVE_CLIENT_BROWSER_EVIDENCE);
  console.log(`Client Browser fixture listening on ${server.port}`);
}
