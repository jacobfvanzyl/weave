import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ManagedBrowserProcess } from '../src/browser-service/managed-process.ts';
import { serveBrowserService } from '../src/browser-service/service.ts';
import { BrowserServiceClient } from '../src/browser-service/client.ts';
import type { ManagedPageSummary } from '../src/browser-service/managed-pages.ts';
const binary = process.env.CEF_BINARY;
if (!binary) throw new Error('Set CEF_BINARY to the product native runtime executable');
const state = await mkdtemp('/tmp/wve79-pages-');
const evidence = process.env.BROWSER_EVIDENCE ?? '/tmp/wve79-managed-browser-acceptance.json';
const fixture = Bun.serve({ hostname:'127.0.0.1',port:0,fetch:()=>new Response('<!doctype html><title>Managed browser acceptance</title><style>body{margin:0;background:#fab387;color:#11111b;font:24px sans-serif}button{width:150px;height:100px}</style><button onclick="window.clicks++">Click</button><div>Managed CEF pixels</div><script>window.clicks=0;window.ticks=0;setInterval(()=>ticks++,50)</script>',{headers:{'content-type':'text/html'}}) });
let service = await serveBrowserService({stateDirectory:state,binary:'/unused-legacy-chrome',cefBinary:resolve(binary)});
let client = new BrowserServiceClient(state);
const results:Record<string,unknown>={state}; let success=false;
const assert = (value:unknown,message:string) => {if(!value)throw new Error(message);};
const pageCall = (page:ManagedPageSummary,method:string,arguments_:object={}) => client.managedPage(method,{pageId:page.pageId,generation:page.generation,arguments:arguments_});
const evaluate = async(page:ManagedPageSummary,expression:string,userGesture=false) => (await pageCall(page,'page.cdp',{method:'Runtime.evaluate',arguments:{expression,returnByValue:true,userGesture}})).result?.value;
const wait = async(check:()=>Promise<boolean>) => {const until=Date.now()+Number(process.env.BROWSER_ACCEPTANCE_TIMEOUT_MS ?? 12000);while(Date.now()<until){if(await check())return;await Bun.sleep(50);}throw new Error('Acceptance condition timed out');};
try {
 const first=(await client.profile('browser.profile.create',{name:'Acceptance A'})).profile;
 const second=(await client.profile('browser.profile.create',{name:'Acceptance B'})).profile;
 const url=`http://127.0.0.1:${fixture.port}/`;
 const a=await client.managedPage<ManagedPageSummary>('page.create',{profileId:first.profileId,pageId:crypto.randomUUID(),url});
 const b=await client.managedPage<ManagedPageSummary>('page.create',{profileId:second.profileId,pageId:crypto.randomUUID(),url});
 await wait(async()=>await evaluate(a,'document.title')==='Managed browser acceptance' && await evaluate(b,'document.title')==='Managed browser acceptance');
 let duplicateRejected=false;
 try {
  const duplicate=await ManagedBrowserProcess.launch({binary:resolve(binary),directory:join(state,'browser-service','profile-data',first.profileId)});
  await duplicate.close();
 } catch {duplicateRejected=true;}
 assert(duplicateRejected,'CEF allowed a second owner of the same Profile');
 assert(await evaluate(a,'document.title')==='Managed browser acceptance','Duplicate launch disturbed the original owner');
 results.profileSingleton=true;
 await evaluate(a,"localStorage.setItem('profile-proof','A');true");
 assert(await evaluate(b,"localStorage.getItem('profile-proof')")===null,'Profile storage leaked');
 results.profileIsolation=true;
 const additional=await client.managedPage<ManagedPageSummary>('page.create',{profileId:first.profileId,pageId:crypto.randomUUID(),url});
 assert(additional.generation===a.generation,'Same Profile did not reuse runtime');results.runtimeReuse=true;
 await pageCall(a,'page.resize',{width:1000,height:800});
 await wait(async()=>await evaluate(a,'innerWidth')===1000);
 results.viewport=await evaluate(a,'({width:innerWidth,height:innerHeight})');
 const before=await evaluate(a,'ticks');client.dispose();await Bun.sleep(200);client=new BrowserServiceClient(state);
 assert((await evaluate(a,'ticks'))>before,'Unattended page stopped');results.unattended=true;
 const screenshot=await pageCall(a,'page.cdp',{method:'Page.captureScreenshot',arguments:{format:'png'}});
 await writeFile(evidence.replace(/\.json$/,'.png'),Buffer.from(screenshot.data,'base64'));
 results.rfbSocket=a.rfbSocket;
 if (process.env.BROWSER_CAPTURE_READY) {
  const ready=process.env.BROWSER_CAPTURE_READY;
  await writeFile(ready,JSON.stringify({rfbSocket:a.rfbSocket,width:1000,height:800})+'\n',{mode:0o600});
  await wait(async()=>Bun.file(ready+'.done').exists());
  assert(await evaluate(a,'clicks')===0 && await evaluate(a,'innerHeight')===800,'External passive viewer changed page state');
  results.externalPassiveViewerBoundary=true;
 }
 if (process.env.BROWSER_RFB_SNAPSHOT_BINARY) {
  for (const operation of ['resize','click']) {
   const capture = Bun.spawn([resolve(process.env.BROWSER_RFB_SNAPSHOT_BINARY), a.rfbSocket!, '5900', '1', evidence.replace(/\.json$/, `-rfb-${operation}.png`), operation], {stdout:'pipe',stderr:'pipe'});
   const [code, output, errors] = await Promise.all([capture.exited, new Response(capture.stdout).text(), new Response(capture.stderr).text()]);
   assert(code === 0, `RFB ${operation} capture failed: ${output} ${errors}`);
   const measured = JSON.parse(output.trim());
   assert(measured.saved && measured.frames > 0 && measured.width === 1000 && measured.height === 800, 'RFB pixels or passive viewport boundary failed');
  }
  assert(await evaluate(a,'clicks') === 0, 'Passive RFB viewer sent input');
  assert(await evaluate(a,'innerHeight') === 800, 'Passive RFB viewer resized page');
  results.nativeRfbCapture = {width:1000,height:800,passiveInputRejected:true,passiveResizeRejected:true};
 }

 // A native popup remains in the same Profile and carries its opener identity.
 await evaluate(a,`window.open('${url}?popup','_blank');true`,true);
 await wait(async()=>{const {pages}=await client.managedPage<{pages:ManagedPageSummary[]}>('page.list');return pages.some(page=>page.openerPageId===a.pageId&&page.profileId===first.profileId);});
 results.managedPopup=true;
 await client.managedPage('page.close',{pageId:additional.pageId,generation:additional.generation});
 const beforeRestart=(await client.managedPage<{pages:ManagedPageSummary[]}>('page.list')).pages;
 client.dispose();await service.close();
 service=await serveBrowserService({stateDirectory:state,binary:'/unused-legacy-chrome',cefBinary:resolve(binary)});client=new BrowserServiceClient(state);
 const afterRestart=(await client.managedPage<{pages:ManagedPageSummary[]}>('page.list')).pages;
 assert(afterRestart.length===beforeRestart.length&&afterRestart.every(page=>!page.available),'Restart silently restored or lost page records');results.explicitRestoreRequired=true;
 const restored=await client.managedPage<ManagedPageSummary>('page.restore',{pageId:a.pageId});
 await wait(async()=>await evaluate(restored,'document.title')==='Managed browser acceptance');
 assert(await evaluate(restored,"localStorage.getItem('profile-proof')")==='A','Persistent Profile was lost');results.profilePersistence=true;
 let rejected=false;try{await pageCall(a,'page.reload');}catch{rejected=true;}assert(rejected,'Old generation accepted after Restore');results.staleGenerationRejected=true;
 results.success=true;success=true;console.log(JSON.stringify(results,null,2));
} finally {
 client.dispose();await service.close();await fixture.stop(true);
 await writeFile(evidence,JSON.stringify(results,null,2)+'\n');
 if(success)await rm(state,{recursive:true,force:true});else console.error(`Preserved acceptance state: ${state}`);
}
