// Read-only diagnostics for the spike's synthetic pages; pass only its temporary Chrome profile.
import {readFile} from 'node:fs/promises';
const directory = process.argv[2];
if (!directory?.includes('/weave-browser-spike-')) throw new Error('Expected an isolated spike profile path');
const [port] = (await readFile(directory + '/DevToolsActivePort', 'utf8')).split('\n');
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as any;
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => {ws.onopen=()=>resolve();ws.onerror=()=>reject(new Error('CDP unavailable'))});
let id=0;
const pending=new Map<number,{resolve:(v:any)=>void,reject:(e:Error)=>void,timer:ReturnType<typeof setTimeout>}>();
ws.onmessage=event=>{const m=JSON.parse(String(event.data));const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}};
const send=(method:string,params:object={},sessionId?:string)=>new Promise<any>((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(new Error('CDP timeout'))},5000);pending.set(n,{resolve,reject,timer});ws.send(JSON.stringify({id:n,method,params,sessionId}))});
try {
 const {targetInfos}=await send('Target.getTargets');const pages=[];let mutedTabs=[];
 for(const t of targetInfos){
  if(t.type==='page'&&/^http:\/\/127\.0\.0\.1:\d+\/fixture\?tab=/.test(t.url)){
   const {sessionId}=await send('Target.attachToTarget',{targetId:t.targetId,flatten:true});
   const {result}=await send('Runtime.evaluate',{expression:'({tab, frames:n, clicks, width:innerWidth, height:innerHeight, audio:typeof ac!=="undefined"?ac?.state:null})',returnByValue:true},sessionId);
   pages.push(result.value);
  } else if(t.type==='service_worker'&&t.url.startsWith('chrome-extension://')) {
   const {sessionId}=await send('Target.attachToTarget',{targetId:t.targetId,flatten:true});
   const {result}=await send('Runtime.evaluate',{expression:'chrome.tabs.query({}).then(tabs=>tabs.map(tab=>({id:tab.id,muted:tab.mutedInfo?.muted})))',awaitPromise:true,returnByValue:true},sessionId);
   mutedTabs=result.value;
  }
 }
 console.log(JSON.stringify({at:new Date().toISOString(),browser:version.Browser,pages,mutedTabs}));
} finally {ws.close()}
