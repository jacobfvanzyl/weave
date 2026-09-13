import {writeFile} from 'node:fs/promises';
const port=Number(process.argv[2]??19229), output=process.argv[3], action=process.argv[4]??'freeze';
const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json() as any[];
const page=pages.find(p=>p.type==='page' && p.url.endsWith('/page.html'));if(!page)throw new Error('Owned fixture not found');
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise<void>((resolve,reject)=>{ws.onopen=()=>resolve();ws.onerror=reject;});
let id=0;const pending=new Map<number,{resolve:(x:any)=>void,reject:(x:any)=>void}>();
ws.onmessage=e=>{const m=JSON.parse(String(e.data));const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}};
function send(method:string,params:any={}){const request=++id;return new Promise<any>((resolve,reject)=>{pending.set(request,{resolve,reject});ws.send(JSON.stringify({id:request,method,params}));});}
try{
 if(action==='resume')await send('Runtime.evaluate',{expression:'document.getAnimations().forEach(a=>a.play());true'});
 if(action==='freeze')await send('Runtime.evaluate',{expression:"document.getAnimations().forEach(a=>{a.pause();a.currentTime=1000});localStorage.setItem('rfb-spike-profile','retained');true",returnByValue:true});
 await new Promise(r=>setTimeout(r,500));
 const state=await send('Runtime.evaluate',{expression:"({width:innerWidth,height:innerHeight,clicks:window.clicks,profile:localStorage.getItem('rfb-spike-profile'),animation:document.getAnimations()[0]?.playState})",returnByValue:true});
 if(output){const image=await send('Page.captureScreenshot',{format:'png'});await writeFile(output,Buffer.from(image.data,'base64'));}
 console.log(JSON.stringify(state.result.value));
}finally{ws.close();}
