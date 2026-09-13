// Diagnostic only: LayerTree evidence is not a Viz capture or resource proof.
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
const binary=process.env.CHROME_BINARY;
if(!binary) throw new Error('CHROME_BINARY required');
if(process.env.REFERENCE_PNG && process.env.WEAVE_VIZ_CAPTURE_DIR) throw new Error('Run screenshot references separately from Viz capture measurements');
const root=resolve(import.meta.dir,'../test-pages');
const fixture=process.env.PROBE_FIXTURE ?? 'transforms.html';
const allowed=new Set(['transforms.html','transforms-advanced.html','affine.html','primitives.html','clipping.html','opacity.html','effects.html','iframe.html','child.html']);
if(!allowed.has(fixture)) throw new Error('Unknown fixture');
let fixturePort=0;
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
 const name=new URL(request.url).pathname.slice(1)||fixture;
 if(!allowed.has(name)) return new Response('Not found',{status:404});
 let body=(await Bun.file(root+'/'+name).text()).replaceAll(':9880/',':'+fixturePort+'/');
 if(process.env.OOPIF_STATIC==='1' && name==='iframe.html') body=body.replace('/child.html','/child.html?position=80');
 return new Response(body,{headers:{'content-type':'text/html'}});
}});
fixturePort=server.port!;
const profile=await mkdtemp(tmpdir()+'/weave-viz-layer-');
const child=Bun.spawn([binary,'--headless','--no-sandbox','--disable-gpu','--disable-gpu-compositing','--site-per-process','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'--no-first-run','--window-size=800,600',`http://127.0.0.1:${server.port}/${fixture}`],{stdout:'ignore',stderr:process.env.CHROME_STDERR ? Bun.file(process.env.CHROME_STDERR) : 'ignore'});
let socket:WebSocket|undefined;
try {
 let port='';
 for(let i=0;i<100;i++){try{port=(await readFile(profile+'/DevToolsActivePort','utf8')).split('\n')[0]!;break}catch{};if(child.exitCode!==null)throw new Error('Chrome exited');await Bun.sleep(100)}
 if(!port)throw new Error('Chrome startup timeout');
 const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json() as any[];
 const tab=tabs.find(t=>t.type==='page');if(!tab)throw new Error('Missing page');
 socket=new WebSocket(tab.webSocketDebuggerUrl);
 await new Promise<void>((ok,bad)=>{socket!.onopen=()=>ok();socket!.onerror=()=>bad(new Error('CDP failed'))});
 let id=0;const pending=new Map<number,{ok:(v:any)=>void,bad:(e:Error)=>void,timer:Timer}>();
 let layers:any[]=[];const paintEvents:any[]=[];
 socket.onmessage=e=>{const m=JSON.parse(String(e.data));if(m.id){const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.bad(new Error(JSON.stringify(m.error))):p.ok(m.result)}}else if(m.method==='LayerTree.layerTreeDidChange')layers=m.params.layers??[];else if(m.method==='LayerTree.layerPainted')paintEvents.push(m.params)};
 function send(method:string,params:object={}):Promise<any>{return new Promise((ok,bad)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);bad(new Error('Timeout '+method))},10000);pending.set(n,{ok,bad,timer});socket!.send(JSON.stringify({id:n,method,params}))})}
 await send('LayerTree.enable');await send('DOM.enable');
 let ready=false;
 const readinessDeadline=performance.now()+10000;
 while(performance.now()<readinessDeadline){
  const state=await send('Runtime.evaluate',{expression:`location.pathname===${JSON.stringify('/'+fixture)} && document.readyState==='complete' && !!document.body`,returnByValue:true}).catch(()=>null);
  if(state?.result?.value===true){ready=true;break}
  if(child.exitCode!==null)throw new Error('Chrome exited while loading fixture');
  await Bun.sleep(100);
 }
 if(!ready)throw new Error('Fixture did not finish loading');
 await send('Emulation.setDeviceMetricsOverride',{width:800,height:600,deviceScaleFactor:1,mobile:false});
 await Bun.sleep(750);
 let backend:number|null=null;
 const before=structuredClone(layers);const paintStart=paintEvents.length;
 if(fixture==='transforms.html'){
  const doc=await send('DOM.getDocument');const node=await send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#card'});const detail=await send('DOM.describeNode',{nodeId:node.nodeId});
  backend=detail.node.backendNodeId;
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:80,y:38,button:'left',clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:80,y:38,button:'left',clickCount:1});
 }
 await Bun.sleep(750);
 const after=structuredClone(layers);
 const state=await send('Runtime.evaluate',{expression:'JSON.stringify(window.spikeState ? window.spikeState() : {url:location.href,iframeCount:frames.length})',returnByValue:true});
 if(process.env.REFERENCE_PNG){
  const screenshot=await send('Page.captureScreenshot',{format:'png',fromSurface:true});
  await writeFile(process.env.REFERENCE_PNG,Buffer.from(screenshot.data,'base64'));
 }
 if(process.env.CAPTURE_ANIMATE==='1' && fixture==='transforms.html'){await send('Runtime.evaluate',{expression:'document.querySelector("#animate").click()'});await Bun.sleep(750)}
 const targets=await send('Target.getTargets');
 const version=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();
 delete (version as any).webSocketDebuggerUrl;
 const result={kind:'Chromium-LayerTree-diagnostic',notVizResourceProof:true,fixture,version,viewport:{width:800,height:600,deviceScaleFactor:1},vizCaptureRequested:!!process.env.WEAVE_VIZ_CAPTURE_DIR,screenshotReferenceRequested:!!process.env.REFERENCE_PNG,oopifStatic:process.env.OOPIF_STATIC==='1',flags:['--disable-gpu','--disable-gpu-compositing','--site-per-process'],targets:targets.targetInfos,cardBackendNodeId:backend,before,after,paintEventsAfterClick:paintEvents.slice(paintStart),pageState:JSON.parse(state.result.value)};
 console.log(JSON.stringify(result));
 await send('Browser.close').catch(()=>{});
} finally {
 socket?.close();
 // Let Browser.close flush the capture writer before terminating a stuck child.
 for(let i=0;i<50 && child.exitCode===null;i++) await Bun.sleep(100);
 if(child.exitCode===null) child.kill();
 await child.exited;server.stop(true);
 await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
