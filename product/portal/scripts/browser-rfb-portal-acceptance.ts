import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { Portal } from '../src/portal.ts';
import { startPortalServer } from '../src/server.ts';
import { serveBrowserService } from '../src/browser-service/service.ts';
import { BrowserServiceClient } from '../src/browser-service/client.ts';
import { authentication, generatePortalKey, RpcSocket, type PortalCredentialSigner } from './rpc-client.ts';
import { PORTAL_PAIR_REQUEST_TYPE, PORTAL_WEBSOCKET_PROTOCOL } from '@weave/product-protocol';

const scale = Number(process.env.BROWSER_DEVICE_SCALE ?? 1);
const binary = process.env.CEF_BINARY, decoder = process.env.BROWSER_RFB_SNAPSHOT_BINARY;
if (!binary || (!decoder && !process.env.BROWSER_CAPTURE_READY)) throw new Error('CEF_BINARY plus a native decoder or external capture marker is required');
const root = await mkdtemp('/tmp/wve-rfb-portal-');
const evidence = process.env.BROWSER_EVIDENCE ?? '/tmp/wve79-rfb-portal-acceptance.json';
const assert = (value: unknown, reason: string) => { if (!value) throw new Error(reason); };
const wait = async (check: () => Promise<boolean> | boolean, timeoutMs = 15000) => { const until = Date.now() + timeoutMs; while (!await check()) { if (Date.now() > until) throw new Error('Portal browser acceptance timed out'); await Bun.sleep(25); } };
const fixture = Bun.serve({ hostname:'127.0.0.1', port:0, fetch:()=>new Response('<!doctype html><title>Portal RFB acceptance</title><style>body{margin:0;background:#fab387;font:24px sans-serif}button{width:150px;height:100px}</style><button onclick="clicks++">Click</button><div>Authenticated Portal pixels</div><script>window.clicks=0;window.ticks=0;setInterval(()=>ticks++,50)</script>', { headers:{'content-type':'text/html'} }) });
const owner = await serveBrowserService({stateDirectory:root,binary:'/unused-legacy-chrome',cefBinary:resolve(binary)});
const backend = new BrowserServiceClient(root,'/unused-legacy-chrome',resolve(binary));
const portal = await Portal.open({stateDirectory:root,listen:{hostname:'127.0.0.1',port:0},displayName:'RFB acceptance',allowedOrigins:[],executionContexts:[],agents:[]},{terminalBackend:false,browserBackend:backend});
const server = startPortalServer(portal);
const sockets: RpcSocket[] = [], streams: WebSocket[] = [], locals: Socket[] = [];
let proxy: ReturnType<typeof createServer> | undefined, success=false;
const results: Record<string,unknown> = {state:root};
async function openDisplay(signer: PortalCredentialSigner, ticket: string) {
 const ws = new WebSocket(`ws://127.0.0.1:${server.addr.port}/browser/rfb`,PORTAL_WEBSOCKET_PROTOCOL);ws.binaryType='arraybuffer';streams.push(ws);
 let ready!:()=>void, reject!: (error:Error)=>void, local:Socket|undefined, pending:Buffer[]=[], size=0;
 const bound = new Promise<void>((resolve,fail)=>{ready=resolve;reject=fail;});
 ws.addEventListener('message',event=>{
  if(typeof event.data==='string'){if(JSON.parse(event.data).type==='browser.rfb.ready')ready();return;}
  const bytes=Buffer.from(event.data);size+=bytes.length;
  if(local){if(local.writableLength+bytes.length>4*1024*1024){ws.close();return;}local.write(bytes);}
  else {if(size>4*1024*1024){ws.close();return;}pending.push(bytes);}
 });
 ws.addEventListener('close',()=>{reject(new Error('Display closed during attachment'));local?.destroy();});
 await authentication(ws,signer);
 ws.send(JSON.stringify({type:'browser.rfb.bind',ticket}));await bound;
 return {ws,attach(socket:Socket){local=socket;for(const bytes of pending)socket.write(bytes);pending=[];socket.on('data',bytes=>ws.send(bytes));socket.on('close',()=>ws.close());},get bytes(){return size;}};
}
try {
 const {profile}=await backend.profile('browser.profile.create',{name:'Portal acceptance'});
 const key=await generatePortalKey();
 const paired=await portal.security.redeemPairing({type:PORTAL_PAIR_REQUEST_TYPE,token:await portal.security.createPairingToken(60000),label:'Isolated acceptance',publicKey:key.publicKey});
 const signer={...key,credentialId:paired.principal.credentialId};
 const openRpc=async()=>{const rpc=await RpcSocket.open(`ws://127.0.0.1:${server.addr.port}/rpc`,signer);sockets.push(rpc);return rpc;};
 const a=await openRpc(),b=await openRpc();
 const hostId=portal.security.hostId;
 const initial=(await a.request('workspace.composition.get',{hostId}) as any).composition;
 const {page:created}=await a.request('browser.pane.create',{hostId,workspaceId:'browser-acceptance',workspaceName:'Browser acceptance',expectedRevision:initial.revision,paneId:crypto.randomUUID(),profileId:profile.profileId,url:`http://127.0.0.1:${fixture.port}/`,axis:'vertical'}) as any;
 results.browserPaneCreated=true;results.trustedHumanProfileAccess=true;
 const evaluate=async(expression:string)=>(await backend.managedPage('page.cdp',{pageId:created.pageId,generation:created.generation,arguments:{method:'Runtime.evaluate',arguments:{expression,returnByValue:true,awaitPromise:true}}}).catch(cause=>{throw new Error(`Fixture evaluation failed: ${expression.slice(0,100)}`,{cause});})).result?.value;
 await wait(async()=>await evaluate('document.title')==='Portal RFB acceptance');

 const attach=async(rpc:RpcSocket)=>rpc.request('browser.page.view.attach',{profileId:profile.profileId,pageId:created.pageId,generation:created.generation,mode:'control'}) as Promise<{viewId:string;ticket:string}>;
 const av=await attach(a),bv=await attach(b);
 const af=await a.request('browser.page.view.focus',{viewId:av.viewId,width:800,height:600}) as {focusEpoch:number};
 const bf=await b.request('browser.page.view.focus',{viewId:bv.viewId,width:1000,height:800,deviceScaleFactor:scale}) as {focusEpoch:number};
 let stale=false;try{await a.request('browser.page.view.input',{viewId:av.viewId,focusEpoch:af.focusEpoch,method:'Input.insertText',arguments:{text:'stale'}});}catch{stale=true;}assert(stale,'Stale owner sent input');results.focusHandoff=true;
 let staleSelection=false;try{await a.request('browser.page.view.interaction',{viewId:av.viewId,focusEpoch:af.focusEpoch});}catch{staleSelection=true;}assert(staleSelection,'Stale owner read selection');results.selectionOwnership=true;
 let staleContext=false;try{await a.request('browser.page.view.context',{viewId:av.viewId,focusEpoch:af.focusEpoch,x:20,y:20});}catch{staleContext=true;}assert(staleContext,'Stale viewer requested context');results.contextOwnership=true;
 for(const type of ['mousePressed','mouseReleased'])await b.request('browser.page.view.input',{viewId:bv.viewId,focusEpoch:bf.focusEpoch,method:'Input.dispatchMouseEvent',arguments:{type,x:50,y:60,button:'left',clickCount:1}});
 assert(await evaluate('clicks')===1,'Authorized CDP input failed');
 assert(await evaluate('devicePixelRatio')===scale && await evaluate('innerWidth')===1000 && await evaluate('innerHeight')===800,'Retina rendering changed logical page geometry'); results.deviceScaleFactor=scale;results.authorizedInput=true;
 // Exercise the same native pointer path used by clients. Mac form popups are deferred.
 await evaluate(`document.body.insertAdjacentHTML('beforeend','<a id="hover" style="position:absolute;left:200px;top:20px" href="#hover">Hover target</a><input id="edit" value="alpha beta gamma" style="position:absolute;left:200px;top:70px;width:300px;font:24px sans-serif"><select id="choice" style="position:absolute;left:200px;top:140px;width:250px;font:24px sans-serif"><option>First</option><option>Second</option><option>Third</option></select>');true`);
 const pointer=async(type:string,x:number,y:number,buttons=0,clickCount=1)=>b.request('browser.page.view.input',{viewId:bv.viewId,focusEpoch:bf.focusEpoch,method:'Input.dispatchMouseEvent',arguments:{type,x,y,buttons,button:'left',clickCount}});
 const interaction=()=>b.request('browser.page.view.interaction',{viewId:bv.viewId,focusEpoch:bf.focusEpoch}) as Promise<{cursor:number;text:string}>;
 await pointer('mouseMoved',230,30);
 await wait(async()=>(await interaction()).cursor===2);
 assert(await evaluate('document.querySelector("#hover").matches(":hover")'),'Hover did not reach Chromium');
 for(const type of ['mousePressed','mouseReleased']) await pointer(type,220,85,type==='mousePressed'?1:0,2);
 await wait(async()=>(await interaction()).text==='alpha');
 const selected=await interaction();
 await b.request('browser.page.view.input',{viewId:bv.viewId,focusEpoch:bf.focusEpoch,method:'Input.dispatchKeyEvent',arguments:{type:'rawKeyDown',key:'Backspace',windowsVirtualKeyCode:8,commands:['DeleteBackward']}});
 // Stock Chromium retains the separator on Linux and removes it on Mac in
 // this fixture. Require the selected word to disappear without other edits.
 await wait(async()=>['beta gamma',' beta gamma'].includes(await evaluate('document.querySelector("#edit").value')));
 const afterCut=await evaluate('document.querySelector("#edit").value');
 const afterPaste=`Weave ✓${afterCut}`;
 await b.request('browser.page.view.input',{viewId:bv.viewId,focusEpoch:bf.focusEpoch,method:'Input.insertText',arguments:{text:'Weave ✓'}});
 await wait(async()=>await evaluate('document.querySelector("#edit").value')===afterPaste);
 for(const type of ['mousePressed','mouseReleased']) await pointer(type,220,85,type==='mousePressed'?1:0,3);
 await wait(async()=>(await interaction()).text===afterPaste);
 const context=(x:number,y:number)=>b.request('browser.page.view.context',{viewId:bv.viewId,focusEpoch:bf.focusEpoch,x,y}) as Promise<{text:string;canCopy:boolean;canCut:boolean;canPaste:boolean;canSelectAll:boolean}>;
 const mode=async()=>((await interaction()) as unknown as {inputMode:number}).inputMode;
 await wait(async()=>await mode()===0);
 const editable=await context(220,85);assert(editable.canCopy&&editable.canCut&&editable.canPaste,'Editable selection lost context actions');
 await evaluate('edit.readOnly=true;edit.blur();edit.focus();edit.select();true');await Bun.sleep(150);
 const readOnly=await context(220,85);assert(readOnly.canCopy&&!readOnly.canCut&&!readOnly.canPaste,'Readonly context exposed mutations');
 for(const type of ['mousePressed','mouseReleased'])await pointer(type,700,100,type==='mousePressed'?1:0);
 await wait(async()=>await mode()===1);
 const plain=await context(700,100);assert(!plain.canCopy&&!plain.canCut&&!plain.canPaste,'Plain page exposed clipboard edits');
 await evaluate('edit.readOnly=false;edit.type="password";edit.focus();edit.select();true');await Bun.sleep(150);
 const password=await context(220,85);assert(!password.canCopy&&!password.canCut&&password.canPaste,'Password context exposed copy or lost paste');
 await evaluate('edit.type="text";edit.disabled=true;edit.blur();true');await Bun.sleep(150);
 const disabled=await context(220,85);assert(!disabled.canCut&&!disabled.canPaste,'Disabled input exposed edits');
 await evaluate(`edit.disabled=false;document.body.insertAdjacentHTML('beforeend','<div id="rich" contenteditable style="position:absolute;left:200px;top:240px;width:300px;height:60px">Rich text</div>');true`);
 for(const type of ['mousePressed','mouseReleased'])await pointer(type,230,260,type==='mousePressed'?1:0);
 await wait(async()=>await mode()===0);assert((await context(230,260)).canPaste,'Contenteditable lost paste');
 await evaluate('rich.remove();window.preventContext=e=>e.preventDefault();document.addEventListener("contextmenu",preventContext);true');
 const prevented=await context(700,100);assert(!prevented.canCopy&&!prevented.canCut&&!prevented.canPaste&&!prevented.canSelectAll,'Cancelled webpage context menu was replaced');
 await evaluate('document.removeEventListener("contextmenu",preventContext);true');
 results.contextActions={editable,readOnly,plain,password,disabled,cancelled:true};results.keyboardModes={editable:0,contenteditable:0,ordinaryPage:1};
 results.interactions={hover:true,cursor:'pointer',doubleClickSelection:selected.text,tripleClickSelection:true,cut:true,afterCut,unicodePaste:true,formPopupSelection:"deferred: upstream CEF Mac popup regression"};
 await evaluate('["hover","edit","choice"].forEach(id=>document.getElementById(id).remove());true');
 // Human wheel input uses upstream CEF while agent evaluation stays full CDP.
 await evaluate(`window.wheelTrace=[];window.blockWheel=false;document.body.insertAdjacentHTML('beforeend','<div id="wheel-fixture" style="height:5000px"><div id="nested" style="position:absolute;top:200px;left:200px;width:200px;height:120px;overflow:auto"><div style="height:4000px;width:4000px">Nested scroll</div></div></div>');window.addEventListener('wheel',e=>{wheelTrace.push(['wheel',e.deltaX,e.deltaY]);if(blockWheel)e.preventDefault()},{passive:false});window.addEventListener('mousedown',()=>wheelTrace.push(['down']));true`);
 // Layout insertion must reach Chromium's compositor before hit-tested input.
 await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
 const wheel=async(deltaY:number,x=600,y=400,deltaX=0)=>b.request('browser.page.view.input',{viewId:bv.viewId,focusEpoch:bf.focusEpoch,method:'Input.dispatchMouseEvent',arguments:{type:'mouseWheel',x,y,deltaX,deltaY}});
 for(let i=0;i<10;i++)await wheel(.25);
 await Bun.sleep(200);
 assert(await evaluate('scrollY')===3,`Fractional wheel movement was rounded away: ${JSON.stringify(await evaluate('({scrollY,events:wheelTrace})'))}`);
 await evaluate('scrollTo(0,0);true');await Bun.sleep(100);
 await wheel(120,250,250,32);await Bun.sleep(200);
 const nestedScroll=await evaluate('({top:document.querySelector("#nested").scrollTop,left:document.querySelector("#nested").scrollLeft,page:scrollY,events:wheelTrace})');
 assert(nestedScroll.top===120&&nestedScroll.left===32&&nestedScroll.page===0,`Native wheel lost nested scrolling or horizontal units: ${JSON.stringify(nestedScroll)}`);
 await evaluate('blockWheel=true;wheelTrace=[];true');await wheel(80);await Bun.sleep(100);
 assert(await evaluate('scrollY')===0&&await evaluate('wheelTrace.length')===1,'Page wheel cancellation was bypassed');
 await evaluate('blockWheel=false;wheelTrace=[];true');
 await wheel(8);
 for(const type of ['mousePressed','mouseReleased'])await b.request('browser.page.view.input',{viewId:bv.viewId,focusEpoch:bf.focusEpoch,method:'Input.dispatchMouseEvent',arguments:{type,x:600,y:400,button:'left',clickCount:1}});
 assert(await evaluate('wheelTrace.map(e=>e[0]).join(",")')==='wheel,down','Wheel/button ordering changed');
 await evaluate('document.querySelector("#wheel-fixture").remove();scrollTo(0,0);true');await Bun.sleep(100);
 results.nativeWheel={fractionalPixels:3,nestedVertical:120,nestedHorizontal:32,pageCancellation:true,wheelBeforeButton:true};
 if (scale !== 1) {
  for (const density of [1, scale]) {
   await b.request('browser.page.view.focus',{viewId:bv.viewId,width:1000,height:800,deviceScaleFactor:density});
   await wait(async()=>await evaluate('devicePixelRatio')===density);
   assert(await evaluate('innerWidth')===1000&&await evaluate('clicks')===1,'Scale-only change altered page state or geometry');
  }
  results.scaleOnlyHandoff=true;
 }
 // Reclaiming the same viewport must retain pixels outside the next dirty rectangle.
 for(let repeat=0;repeat<3;repeat++) await b.request('browser.page.view.focus',{viewId:bv.viewId,width:1000,height:800,deviceScaleFactor:scale});
 await evaluate("document.querySelector('button').style.background='#88ccaa';true");
 await Bun.sleep(100);
 results.sameViewportFocusClaims=3;
 const display=await openDisplay(signer,bv.ticket);
 const path=join(root,'decoder.sock');proxy=createServer(socket=>{locals.push(socket);display.attach(socket);});await new Promise<void>(resolve=>proxy!.listen(path,resolve));
 let capture: Record<string,unknown>;
 if (decoder) {
  const child=Bun.spawn([resolve(decoder),path,'5900','1',evidence.replace(/\.json$/,'.png'),'resize'],{stdout:'pipe',stderr:'pipe'});
  const [code,output,error]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  assert(code===0,`Native decoder failed: ${output} ${error}`);capture=JSON.parse(output.trim());
  assert(capture.width===1000*scale&&capture.height===800*scale&&Number(capture.frames)>0&&capture.saved,'Native Portal framebuffer mismatch');
 } else {
  const marker=process.env.BROWSER_CAPTURE_READY!;
  await writeFile(marker,JSON.stringify({rfbProxy:path,width:1000,height:800,deviceScaleFactor:scale})+'\n',{mode:0o600});
  await wait(()=>Bun.file(marker+'.done').exists(),Number(process.env.BROWSER_ACCEPTANCE_TIMEOUT_MS ?? 15000));
  capture={external:true,width:1000,height:800,deviceScaleFactor:scale};
 }
 const image=await backend.managedPage('page.cdp',{pageId:created.pageId,generation:created.generation,arguments:{method:'Page.captureScreenshot',arguments:{format:'png'}}});
 await writeFile(evidence.replace(/\.json$/, '-reference.png'),Buffer.from(image.data,'base64'));
 if (decoder && process.platform === 'darwin') {
  const comparator=join(root,'compare-browser-pixels');
  const compile=Bun.spawn(['xcrun','clang','-fobjc-arc','-framework','Foundation','-framework','ImageIO','-framework','CoreGraphics',resolve(import.meta.dir,'compare-browser-pixels.m'),'-o',comparator],{stdout:'pipe',stderr:'pipe'});
  assert(await compile.exited===0,`Pixel comparator build failed: ${await new Response(compile.stderr).text()}`);
  const comparison=Bun.spawn([comparator,evidence.replace(/\.json$/, '-reference.png'),evidence.replace(/\.json$/,'.png')],{stdout:'pipe',stderr:'pipe'});
  const output=await new Response(comparison.stdout).text();
  assert(await comparison.exited===0,`Same-size focus damaged framebuffer pixels: ${output}`);
  results.pixelComparison=JSON.parse(output);
 }
 assert(await evaluate('innerHeight')===800,'RFB viewer bypassed viewport authority');results.nativeRfb={...capture,bytes:display.bytes};
 const before=await evaluate('ticks');a.close();b.close();await Bun.sleep(150);assert(await evaluate('ticks')>before,'Browser died with its RPC clients');results.unattendedAfterRpcDisconnect=true;
 const c=await openRpc();
 await backend.managedPage('page.cdp',{pageId:created.pageId,generation:created.generation,arguments:{method:'Runtime.evaluate',arguments:{expression:`window.open('http://127.0.0.1:${fixture.port}/popup')`,userGesture:true}}});
 let composition:any;
 await wait(async()=>{composition=(await c.request('workspace.composition.get',{hostId}) as any).composition;return composition.workspaces[0]?.layout?.kind==='split';});
 const popup=composition.workspaces[0].layout.children[1];
 assert(composition.workspaces[0].layout.axis==='horizontal'&&popup.kind==='browser'&&popup.profileId===profile.profileId,'Popup did not inherit a Right split');results.popupRightSplit=true;
 const popupPage=(await backend.managedPage('page.list',{profileId:profile.profileId})).pages.find((page:any)=>page.pageId===popup.paneId);
 await c.request('browser.pane.close',{hostId,expectedRevision:composition.revision,paneId:popup.paneId,profileId:profile.profileId,generation:popupPage.generation,confirmed:true});
 assert((await backend.managedPage('page.list',{profileId:profile.profileId})).pages.length===1,'Shared close left a popup alive');results.sharedPopupClose=true;
 assert(await evaluate('clicks')===1,'Popup lifecycle reset its opener');
 // A partial RFB reply stalls stock LibVNC inside this Profile worker.
 // Prove the limitation and recovery through the authenticated Portal relay.
 const slowView=await attach(c),slow=await openDisplay(signer,slowView.ticket);
 await wait(()=>slow.bytes>=12);slow.ws.send(new Uint8Array([82]));await Bun.sleep(50);
 const ticksBeforeStall=await evaluate('ticks');
 const otherView=await attach(c),following=await openDisplay(signer,otherView.ticket);
 await Bun.sleep(150);
 const blockedGreeting=following.bytes===0;
 assert(await evaluate('ticks')>ticksBeforeStall,'Slow RFB viewer blocked Chromium work');
 const detachedAt=performance.now();slow.ws.close();await wait(()=>following.bytes>=12);
 results.slowViewer={profileDisplayCouplingObserved:blockedGreeting,chromiumContinued:true,recoveryAfterPeerCloseMs:performance.now()-detachedAt};
 following.ws.close();
 const cv=await attach(c),live=await openDisplay(signer,cv.ticket);
 await portal.security.revokeCredential(signer.credentialId);await wait(()=>live.ws.readyState===WebSocket.CLOSED);
 assert(await evaluate('document.title')==='Portal RFB acceptance','Revocation closed the page');results.revokedDisplayBrowserAlive=true;
 results.success=true;success=true;console.log(JSON.stringify(results,null,2));
} finally {
 streams.forEach(ws=>ws.close());sockets.forEach(rpc=>rpc.close());locals.forEach(socket=>socket.destroy());
 if(proxy)await new Promise<void>(resolve=>proxy!.close(()=>resolve()));
 await server.shutdown();await portal.close();await owner.close();await fixture.stop(true);
 await writeFile(evidence,JSON.stringify(results,null,2)+'\n');if(success)await rm(root,{recursive:true,force:true});else console.error(`Retained fixture state: ${root}`);
}
