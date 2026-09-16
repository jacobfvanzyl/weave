import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Portal } from '../../portal/src/portal.ts';
import { startPortalServer } from '../../portal/src/server.ts';
import { serveBrowserService } from '../../portal/src/browser-service/service.ts';
import { BrowserServiceClient } from '../../portal/src/browser-service/client.ts';
const root = await mkdtemp('/tmp/weave-browser-alpha-');
const binary = resolve(import.meta.dir,'../../portal/dist/browser-runtime/Weave Browser.app/Contents/MacOS/Weave Browser');
const fixture = Bun.serve({hostname:'127.0.0.1',port:0,fetch:() => new Response('<!doctype html><title>Native Browser Acceptance</title><style>body{margin:0;background:#fab387;font:24px sans-serif}button{width:150px;height:100px}</style><button onclick="clicks++;this.textContent=clicks">Click</button><div>Native Alpha Browser Pane</div><input id="text"><script>window.clicks=0</script>',{headers:{'content-type':'text/html'}})});
const owner = await serveBrowserService({stateDirectory:root,binary:'/unused',cefBinary:binary});
const backend = new BrowserServiceClient(root,'/unused',binary);
const portal = await Portal.open({stateDirectory:root,displayName:'Browser acceptance',listen:{hostname:'127.0.0.1',port:0},allowedOrigins:['weave://app'],executionContexts:[],agents:[]},{terminalBackend:false,browserBackend:backend});
const server = startPortalServer(portal);
let success=false;
try {
  await writeFile(join(root,'input.json'),JSON.stringify({hostUrl:`ws://127.0.0.1:${server.addr.port}`,pairingToken:await portal.security.createPairingToken(),workspaceName:'Browser',browserHostId:portal.security.hostId,browserUrl:`http://127.0.0.1:${fixture.port}/`}),{mode:0o600});
  const app = Bun.spawn([resolve(import.meta.dir,'../release/Weave Alpha-darwin-arm64/Weave Alpha.app/Contents/MacOS/Weave Alpha'),'--host-acceptance'],{env:{...process.env,WEAVE_ALPHA_ACCEPTANCE_DIR:root},stdout:Bun.file(join(root,'electron.log')),stderr:Bun.file(join(root,'electron-error.log'))});
  const timer=setTimeout(() => app.kill('SIGTERM'),120000);
  const code=await app.exited;clearTimeout(timer);
  if(code!==0)throw new Error(`Alpha browser acceptance failed (${code})`);
  const {pages}=await backend.managedPage('page.list',{}),page=pages[0];
  if(!page)throw new Error('No Browser page was created');
  const command=(method:string,args:Record<string,unknown>)=>backend.managedPage('page.cdp',{pageId:page.pageId,generation:page.generation,arguments:{method,arguments:args}});
  const clicked=(await command('Runtime.evaluate',{expression:'clicks',returnByValue:true})).result.value;
  if(clicked!==1)throw new Error(`Native browser input failed: clicks=${clicked}`);
  const typed=(await command('Runtime.evaluate',{expression:"document.querySelector('#text').value",returnByValue:true})).result.value;
  if(typed!=='Weave ✓')throw new Error(`Browser text input failed: ${typed}`);
  const screenshot=await command('Page.captureScreenshot',{format:'png'});
  await writeFile(join(root,'reference.png'),Buffer.from(screenshot.data,'base64'));
  success=true;console.log(JSON.stringify({success,root,clicked,typed,native:(await Bun.file(join(root,'result.json')).json())}));
} finally {
  await server.shutdown();await portal.close();await owner.close();await fixture.stop(true);await rm(join(root,'input.json'),{force:true});console.log(`Evidence: ${root}; success=${success}`);
}
