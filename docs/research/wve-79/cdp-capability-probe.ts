import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
const dir=await mkdtemp(tmpdir()+'/wve79-chrome-');
const chrome=Bun.spawn(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','--headless','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+dir,'--no-first-run','--no-default-browser-check','about:blank'],{stdout:'ignore',stderr:'ignore'});
let ws:WebSocket|undefined;
try {
 let port='';for(let i=0;i<100;i++){try{port=(await readFile(dir+'/DevToolsActivePort','utf8')).split('\n')[0];break}catch{} await Bun.sleep(100)}
 if(!port)throw Error('No debug endpoint');
 const version=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();
 const protocol=await(await fetch(`http://127.0.0.1:${port}/json/protocol`)).json();
 const page=protocol.domains.find((d:any)=>d.domain==='Page');
 console.log(JSON.stringify({browser:version.Browser,screencast:page.commands.find((c:any)=>c.name==='startScreencast'),recording:page.commands.find((c:any)=>c.name==='startScreenRecording')??null}));
 ws=new WebSocket(version.webSocketDebuggerUrl);await new Promise((res,rej)=>{ws!.onopen=res;ws!.onerror=rej});
 let id=0;const pending=new Map();const frames:any[]=[];let sessionId:string;
 const send=(method:string,params={},sid?:string)=>new Promise<any>((res,rej)=>{const n=++id;const t=setTimeout(()=>{pending.delete(n);rej(Error('Timeout '+method))},5000);pending.set(n,(m:any)=>{clearTimeout(t);m.error?rej(Error(JSON.stringify(m.error))):res(m.result)});ws!.send(JSON.stringify({id:n,method,params,...(sid?{sessionId:sid}:{})}))});
 ws.onmessage=e=>{const m=JSON.parse(String(e.data));if(m.id)pending.get(m.id)?.(m);else if(m.method==='Page.screencastFrame'){frames.push({bytes:Buffer.from(m.params.data,'base64').length,metadata:m.params.metadata});send('Page.screencastFrameAck',{sessionId:m.params.sessionId},m.sessionId).catch(()=>{})}};
 const {targetId}=await send('Target.createTarget',{url:'about:blank'});({sessionId}=await send('Target.attachToTarget',{targetId,flatten:true}));await Bun.sleep(300);
 await send('Page.enable',{},sessionId);await send('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false},sessionId);
 await send('Page.navigate',{url:'data:text/html,'+encodeURIComponent('<html><body><input id="i"><canvas id="c" width="800" height="500"></canvas><script>let n=0;setInterval(()=>{const x=c.getContext("2d");x.fillStyle="white";x.fillRect(0,0,800,500);x.fillStyle="black";x.font="24px sans-serif";x.fillText("Frame "+n++,20,50);},33)</script></body></html>')},sessionId);
 await Bun.sleep(300);await send('Page.bringToFront',{},sessionId);await send('Page.startScreencast',{format:'jpeg',quality:80,maxWidth:1280,maxHeight:720},sessionId);await Bun.sleep(2000);
 const first=frames.length;await send('Emulation.setDeviceMetricsOverride',{width:800,height:600,deviceScaleFactor:2,mobile:false},sessionId);await Bun.sleep(500);
 console.log(JSON.stringify({twoSecondFrameCount:first,totalFrames:frames.length,firstFrame:frames[0],lastFrame:frames.at(-1),viewport:(await send('Runtime.evaluate',{expression:'JSON.stringify({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})',returnByValue:true},sessionId)).result.value}));
 await send('Page.stopScreencast',{},sessionId);const recording=await send('Page.startScreenRecording',{audio:false,maxWidth:800,maxHeight:600,frameRate:30},sessionId);const chunks:Buffer[]=[];const reads:any[]=[];for(let i=0;i<6;i++){await Bun.sleep(250);const chunk=await send('IO.read',{handle:recording.stream,size:65536},sessionId);const bytes=Buffer.from(chunk.data,chunk.base64Encoded?'base64':'utf8');chunks.push(bytes);reads.push({afterMs:(i+1)*250,bytes:bytes.length,eof:chunk.eof});}await send('Page.stopScreenRecording',{},sessionId);let finalBytes=0;for(let i=0;i<10;i++){const c=await send('IO.read',{handle:recording.stream,size:65536},sessionId);const b=Buffer.from(c.data,c.base64Encoded?'base64':'utf8');chunks.push(b);finalBytes+=b.length;if(c.eof)break;}const bytes=Buffer.concat(chunks);let off=0;const boxes=[];while(off+8<=bytes.length){const size=bytes.readUInt32BE(off);boxes.push({type:bytes.toString('ascii',off+4,off+8),size});if(size<8)break;off+=size;}console.log(JSON.stringify({recordingReads:reads,bytesAfterStop:finalBytes,boxes}));await send('IO.close',{handle:recording.stream},sessionId);await send('Browser.close').catch(()=>{});
}finally{ws?.close();chrome.kill();await chrome.exited;await Bun.sleep(300);await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100})}
