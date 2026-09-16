import { ManagedBrowserProcess } from '../src/browser-service/managed-process.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { inflateSync } from 'node:zlib';
function firstPixel(png:Buffer){
 if(png.readUInt32BE(16)!==2000 || png.readUInt32BE(20)!==1600 || png[24]!==8 || ![2,6].includes(png[25]!))throw new Error('Unexpected PNG geometry/format');
 const parts:Buffer[]=[];for(let at=8;at<png.length;){const length=png.readUInt32BE(at);if(png.toString('ascii',at+4,at+8)==='IDAT')parts.push(png.subarray(at+8,at+8+length));at+=length+12;}
 const row=inflateSync(Buffer.concat(parts));if(row[0]!>4)throw new Error('Invalid PNG row filter');
 // At the top-left pixel, every PNG filter predictor is zero.
 return row.subarray(1,4).toString('hex');
}
const binary=process.env.CEF_BINARY;
if(!binary)throw new Error('CEF_BINARY required');
const root=await mkdtemp('/tmp/weave-gpu-screenshot-');
const runtime=await ManagedBrowserProcess.launch({binary,directory:root});
const results:unknown[]=[];
let page:any,sessionId:string|undefined;
try {
 for(let n=0;n<Number(process.env.BROWSER_SCREENSHOT_ROUNDS ?? 12);n++){
  const pageId=page?.pageId ?? crypto.randomUUID();
  page ??=await runtime.request('page.create',{pageId,url:'data:text/html,<!doctype html><title>GPU capture</title><body style="margin:0;background:%23fab387">GPU screenshot fixture'});
  const call=(method:string,args:object={})=>runtime.request('page.cdp',{pageId,method,arguments:args});
  await call('Runtime.evaluate',{expression:'document.readyState',returnByValue:true});
  for(const scale of [2,1,2]){
   await runtime.request('page.resize',{pageId,width:1000,height:800,deviceScaleFactor:scale});
   await Bun.sleep(100);
  }
  if(n%2){await new Promise<void>((resolve,reject)=>{const socket=createConnection(page.rfbSocket);socket.once('error',reject);socket.once('data',()=>{socket.destroy();resolve();});});}
  await call('Runtime.evaluate',{expression:"document.body.style.background='#88ccaa';true",returnByValue:true});
  await Bun.sleep(100);
  if(process.env.BROWSER_SCREENSHOT_PIPE==='1' && !sessionId){
   const {targetInfos}=await runtime.cdp.call('Target.getTargets');
   const target=targetInfos.find((t:any)=>t.type==='page');
   sessionId=(await runtime.cdp.call('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
  }
  const expected=[40+n*3,90+n*2,140+n].map(v=>v.toString(16).padStart(2,'0')).join('');
  await call('Runtime.evaluate',{expression:`document.body.style.background='#${expected}';true`,returnByValue:true});
  if(n%2)await Bun.sleep(300);
  if(process.env.BROWSER_SCREENSHOT_BRING_FRONT==='1'){if(sessionId)await runtime.cdp.call('Page.bringToFront',{},sessionId);else await call('Page.bringToFront');}
  const started=performance.now();
  let finished=false;
  const diagnostic=setTimeout(()=>{void (async()=>{
   if(finished)return;
   const state=await call('Runtime.evaluate',{expression:'JSON.stringify({state:document.readyState,visibility:document.visibilityState,width:innerWidth,height:innerHeight,dpr:devicePixelRatio})',returnByValue:true});
   const pages=await runtime.request('page.list');
   console.log(JSON.stringify({round:n,pendingMs:performance.now()-started,state,pages}));
   if(process.env.BROWSER_SCREENSHOT_REPAINT==='1')await call('Runtime.evaluate',{expression:"document.body.style.outline='1px solid red';true",returnByValue:true});
  })().catch(error=>console.log({diagnosticError:String(error)}));},2000);
  try {
   const screenshot=sessionId ? (method:string,args:object)=>runtime.cdp.call(method,args,sessionId) : call;
   const result=await screenshot('Page.captureScreenshot',{format:'png',...(process.env.BROWSER_SCREENSHOT_FROM_SURFACE==='0'?{fromSurface:false}:{})});
   const png=Buffer.from(result.data,'base64'),actual=firstPixel(png);
   if(actual!==expected)throw new Error(`Stale screenshot: ${actual}, expected ${expected}`);
   results.push({round:n,ms:performance.now()-started,bytes:png.length,fresh:true});console.log(JSON.stringify(results.at(-1)));
  }finally{finished=true;clearTimeout(diagnostic);}
  if(process.env.BROWSER_SCREENSHOT_REUSE!=='1'){if(sessionId)await runtime.cdp.call('Target.detachFromTarget',{sessionId});sessionId=undefined;await runtime.request('page.close',{pageId});page=undefined;}
 }
 console.log(JSON.stringify({success:true,results}));
}finally{await runtime.close();await rm(root,{recursive:true,force:true});}
