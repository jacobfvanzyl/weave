import {readFile} from 'node:fs/promises';
const [connectionFile, logFile, macViewer, ipadViewer] = process.argv.slice(2);
if (!connectionFile || !logFile || !macViewer || !ipadViewer) throw new Error('Usage: handoff-acceptance.ts connection.json live-host-log mac-viewer ipad-viewer');
const config = await Bun.file(connectionFile).json();
const url = new URL(config.endpoint); url.protocol = 'http:'; url.pathname = '/control';
const entries = async () => (await readFile(logFile, 'utf8')).split('\n').flatMap(line => {try {return [JSON.parse(line)]} catch {return []}});
const results = [];
for (let i = 0; i < 8; i++) {
  const viewer = i % 2 === 0 ? ipadViewer : macViewer;
  const width = i % 2 === 0 ? 800 : 960, height = i % 2 === 0 ? 600 : 640;
  const previous = (await entries()).filter(row => row.event === 'focusApplied' && row.tab === 'A').at(-1)?.generation ?? 0;
  const start = performance.now();
  const response = await fetch(url, {method:'POST', headers:{'content-type':'application/json', authorization:'Bearer '+config.token}, body:JSON.stringify({type:'focus',tab:'A',viewer,width,height})});
  if (!response.ok) throw new Error('Focus rejected: '+response.status);
  let passed = false;
  for (let poll = 0; poll < 100; poll++) {
    const rows = await entries();
    const applied = rows.find(row => row.event === 'focusApplied' && row.tab === 'A' && row.generation > previous && row.owner === viewer && row.width === width && row.height === height);
    if (applied) {
      const frames = rows.filter(row => row.event === 'firstFrame' && row.tab === 'A' && row.generation === applied.generation && row.width === width && row.height === height);
      if ([macViewer, ipadViewer].every(id => frames.some(frame => frame.viewer === id))) {
        results.push({generation:applied.generation,width,height,owner:i%2===0?'iPad':'Mac',bothNativeReceiversReady:true,requestToObservedFramesMs:Math.round(performance.now()-start)});passed=true;break;
      }
    }
    await Bun.sleep(100);
  }
  if (!passed) throw new Error('Native handoff timed out, iteration '+i);
}
console.log(JSON.stringify({test:'eight native handoffs through real Chromium/WebRTC',results},null,2));
