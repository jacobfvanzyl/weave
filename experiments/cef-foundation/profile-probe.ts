import {writeFile} from 'node:fs/promises';
const targets = await (await fetch('http://127.0.0.1:19329/json/list')).json() as any[];
const page = targets.find(t => t.type === 'page' && t.url.startsWith('http://127.0.0.1:19380/'));
if (!page) throw new Error('Owned fixture page not found');
const ws = new WebSocket(page.webSocketDebuggerUrl);
const deadline = setTimeout(() => { ws.close(); throw new Error('Profile probe timed out'); }, 8000);
await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
const result = await new Promise<any>((resolve, reject) => {
  ws.onmessage = e => { const m = JSON.parse(String(e.data)); if (m.id === 1) m.error ? reject(m.error) : resolve(m.result); };
  ws.send(JSON.stringify({id: 1, method: 'Runtime.evaluate', params: {
    expression: "({url: location.href, profile: localStorage.getItem('foundation')})", returnByValue: true,
  }}));
});
clearTimeout(deadline); ws.close();
await writeFile(process.argv[2]!, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (result.result?.value?.profile !== 'persistent') throw new Error('Profile did not persist');
export {};
