import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const dir=process.argv[2]!;const results:any[]=[];
class CDP {
 ws:WebSocket;ready:Promise<void>;id=0;pending=new Map<number,any>();events:any[]=[];
 constructor(url:string){this.ws=new WebSocket(url);this.ready=new Promise<void>((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('WebSocket open timeout')),8000);this.ws.onopen=()=>{clearTimeout(t);resolve()};this.ws.onerror=e=>{clearTimeout(t);reject(e)}});this.ws.onmessage=e=>{const m=JSON.parse(String(e.data));if(m.id){const p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result)}}else this.events.push(m)};}
 async open(){await this.ready}
 send(method:string,params:any={}){const id=++this.id;return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('CDP timeout '+method))},8000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}))})}
 async check(method:string,params:any={}){try{const result=await this.send(method,params);results.push({method,params,ok:true,result});return result}catch(error){results.push({method,params,ok:false,error});return null}}
}
const version=await(await fetch('http://127.0.0.1:19329/json/version')).json() as any;
const targets=await(await fetch('http://127.0.0.1:19329/json/list')).json() as any[];
const target=targets.find(x=>x.type==='page'&&x.url.startsWith('http://127.0.0.1:19380/'));
if(!target)throw new Error('Owned fixture not found');
const browser=new CDP(version.webSocketDebuggerUrl),page=new CDP(target.webSocketDebuggerUrl);await browser.open();await page.open();
try{
 await browser.check('Browser.getVersion');await browser.check('Target.getTargets');
 const context=await browser.check('Target.createBrowserContext');
 const created=await browser.check('Target.createTarget',{url:'http://127.0.0.1:19380/fixture.html?cdp-created=1',background:true});
 if(created)await browser.check('Target.closeTarget',{targetId:created.targetId});
 if(context)await browser.check('Target.disposeBrowserContext',{browserContextId:context.browserContextId});
 await page.check('Runtime.enable');await page.check('Network.enable');await page.check('DOM.getDocument',{depth:1});await page.check('Accessibility.getFullAXTree');
 await page.check('Runtime.evaluate',{expression:"console.log('cdp-validation');fetch('/api/ping?cdp=1').then(r=>r.json())",awaitPromise:true,returnByValue:true});
 await page.check('Debugger.enable');
 const evaluation=page.send('Runtime.evaluate',{expression:'window.debugProbe()',returnByValue:true}).then(result=>({result}),error=>({error}));
 for(let i=0;i<100&&!page.events.some(e=>e.method==='Debugger.paused');i++)await Bun.sleep(20);
 const paused=page.events.find(e=>e.method==='Debugger.paused');results.push({method:'Debugger.paused event',ok:!!paused,result:paused});
 if(paused){await page.check('Debugger.stepOver');await Bun.sleep(100);await page.check('Debugger.resume')}
 results.push({method:'debugProbe return after resume',...await evaluation});await page.check('Debugger.disable');
 await page.check('Runtime.evaluate',{expression:"document.getAnimations().forEach(a=>{a.pause();a.currentTime=1000});({clicks:window.clicks,name:document.querySelector('#name').value,profile:localStorage.getItem('foundation'),width:innerWidth,height:innerHeight})",returnByValue:true});
 await Bun.sleep(300);const image=await page.send('Page.captureScreenshot',{format:'png'});await writeFile(join(dir,'cdp-reference.png'),Buffer.from(image.data,'base64'));
 await writeFile(join(dir,'cdp-events.json'),JSON.stringify(page.events.filter(e=>['Debugger.paused','Debugger.resumed','Runtime.consoleAPICalled','Network.requestWillBeSent','Network.responseReceived'].includes(e.method)),null,2));
}finally{browser.ws.close();page.ws.close();await writeFile(join(dir,'cdp-results.json'),JSON.stringify(results,null,2));}
for(const r of results)console.log(r.method,r.ok===false?'ERROR':r.ok===true?'OK':'RESULT',r.ok===false?JSON.stringify(r.error):'');
export {};
