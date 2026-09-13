// Isolated research only: temporary profile, synthetic page, local WebRTC peers.
// Run with CHROME_BINARY=/path/to/chrome bun <this-file>; macOS Chrome is the default.
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
const dir = await mkdtemp(tmpdir() + '/wve79-webrtc-');
const extension = dir + '/extension';
await mkdir(extension);
await writeFile(extension + '/manifest.json', JSON.stringify({manifest_version:3,name:'Weave isolated capture research',version:'0.0.1',permissions:['tabCapture','offscreen','storage','activeTab'],action:{},background:{service_worker:'worker.js'}}));
await writeFile(extension + '/worker.js', `
chrome.runtime.onMessage.addListener((m) => { if (m.result) chrome.storage.session.set({probe:m.result}); });
chrome.action.onClicked.addListener(async tab => {
 try {
  ${process.env.SPIKE_MUTE_TAB === '1' ? 'await chrome.tabs.update(tab.id, {muted:true});' : ''}
  await chrome.storage.session.set({probe:{stage:'action', tab:tab.id}});
  const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']});
  if (!contexts.length) await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['USER_MEDIA','WEB_RTC'],justification:'Isolated headless browser media feasibility probe'});
  const id=await chrome.tabCapture.getMediaStreamId({targetTabId:tab.id});
  await chrome.runtime.sendMessage({start:id});
 } catch(e) {await chrome.storage.session.set({probe:{stage:'failed',error:String(e)}});}
});
`);
await writeFile(extension + '/offscreen.html', '<html><body><script src="offscreen.js"></script></body></html>');
await writeFile(extension + '/offscreen.js', `
chrome.runtime.onMessage.addListener(m=>{if(m.start) run(m.start).catch(e=>chrome.runtime.sendMessage({result:{stage:'failed',error:String(e)}}));});
async function run(id){
 const stream=await navigator.mediaDevices.getUserMedia({audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:id}},video:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:id,maxWidth:1280,maxHeight:720,maxFrameRate:30}}});
 const tracks=stream.getTracks().map(t=>({kind:t.kind,readyState:t.readyState,settings:t.getSettings()}));
 await chrome.runtime.sendMessage({result:{stage:'captured',tracks}});
 const sender=new RTCPeerConnection({iceServers:[]}), receiver=new RTCPeerConnection({iceServers:[]});
 const pendingSender=[],pendingReceiver=[];
 sender.onicecandidate=e=>{if(e.candidate){if(receiver.remoteDescription)receiver.addIceCandidate(e.candidate);else pendingReceiver.push(e.candidate);}};
 receiver.onicecandidate=e=>{if(e.candidate){if(sender.remoteDescription)sender.addIceCandidate(e.candidate);else pendingSender.push(e.candidate);}};
 const received=new MediaStream();
 receiver.ontrack=e=>received.addTrack(e.track);
 for(const track of stream.getTracks()){
  sender.addTrack(track,stream);
  const transceiver=sender.getTransceivers().find(t=>t.sender.track===track);
  const codecs=RTCRtpSender.getCapabilities(track.kind).codecs;
  const wanted=codecs.filter(c=>c.mimeType.toLowerCase()===(track.kind==='video'?'video/h264':'audio/opus'));
  if(wanted.length)transceiver.setCodecPreferences(wanted);
 }
 await sender.setLocalDescription(await sender.createOffer());
 await receiver.setRemoteDescription(sender.localDescription);
 for(const c of pendingReceiver)await receiver.addIceCandidate(c);
 await receiver.setLocalDescription(await receiver.createAnswer());
 await sender.setRemoteDescription(receiver.localDescription);
 for(const c of pendingSender)await sender.addIceCandidate(c);
 const video=document.createElement('video');video.autoplay=true;video.muted=true;video.srcObject=received;document.body.append(video);await video.play();
 const audioContext=new AudioContext();await audioContext.resume();
 const analyser=audioContext.createAnalyser(), silence=audioContext.createGain();silence.gain.value=0;
 audioContext.createMediaStreamSource(received).connect(analyser).connect(silence).connect(audioContext.destination);
 await new Promise(r=>setTimeout(r,3500));
 const samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);
 const receivedAudio={contextState:audioContext.state,rms:Math.sqrt(samples.reduce((sum,v)=>sum+v*v,0)/samples.length),audibleOutput:false};
 const stats=await receiver.getStats();
 const sourceStats=[];for(const s of (await sender.getStats()).values())if(s.type==='media-source'&&s.kind==='audio')sourceStats.push({audioLevel:s.audioLevel,totalAudioEnergy:s.totalAudioEnergy,totalSamplesDuration:s.totalSamplesDuration});
 const receivedStats=[];
 for(const s of stats.values())if(s.type==='inbound-rtp')receivedStats.push({kind:s.kind,codec:stats.get(s.codecId)?.mimeType,bytesReceived:s.bytesReceived,packetsReceived:s.packetsReceived,framesDecoded:s.framesDecoded,frameWidth:s.frameWidth,frameHeight:s.frameHeight,totalSamplesReceived:s.totalSamplesReceived,totalAudioEnergy:s.totalAudioEnergy});
 await chrome.runtime.sendMessage({result:{stage:'complete',tracks,senderState:sender.connectionState,receiverState:receiver.connectionState,videoSize:{width:video.videoWidth,height:video.videoHeight},receivedAudio,sourceStats,receivedStats}});
 await audioContext.close();sender.close();receiver.close();for(const t of stream.getTracks())t.stop();
}
`);
const chrome=Bun.spawn([process.env.CHROME_BINARY ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','--headless','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--enable-unsafe-extension-debugging','--user-data-dir='+dir+'/profile','--no-first-run','--no-default-browser-check','about:blank'],{stdout:'ignore',stderr:'ignore'});
let ws:WebSocket|undefined;
try {
 let port='';for(let i=0;i<100;i++){try{port=(await readFile(dir+'/profile/DevToolsActivePort','utf8')).split('\n')[0];break}catch{}await Bun.sleep(100)}
 if(!port)throw Error('No debug endpoint');
 const version=await(await fetch(`http://127.0.0.1:${port}/json/version`)).json();console.log(JSON.stringify({browser:version.Browser,mode:'headless',tabMuted:process.env.SPIKE_MUTE_TAB==='1',transport:'WebRTC loopback within offscreen extension',audio:'synthetic tab oscillator, no microphone'}));
 ws=new WebSocket(version.webSocketDebuggerUrl);await new Promise((res,rej)=>{ws!.onopen=res;ws!.onerror=rej});
 let id=0;const pending=new Map<number,(m:any)=>void>();
 const send=(method:string,params={},sessionId?:string)=>new Promise<any>((res,rej)=>{const n=++id;const t=setTimeout(()=>{pending.delete(n);rej(Error('Timeout '+method))},10000);pending.set(n,m=>{pending.delete(n);clearTimeout(t);m.error?rej(Error(method+' '+JSON.stringify(m.error))):res(m.result)});ws!.send(JSON.stringify({id:n,method,params,...(sessionId?{sessionId}:{})}));});
 ws.onmessage=e=>{const m=JSON.parse(String(e.data));if(m.id)pending.get(m.id)?.(m);};
 const loaded=await send('Extensions.loadUnpacked',{path:extension});console.log(JSON.stringify({extensionLoaded:!!loaded.id}));
 const {targetId}=await send('Target.createTarget',{url:'about:blank'});await Bun.sleep(300);
 const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
 const html='<html><body style="margin:0"><button style="width:200px;height:80px" onclick="window.ac=new AudioContext();const o=ac.createOscillator(),g=ac.createGain();g.gain.value=0.05;o.connect(g).connect(ac.destination);o.start();">Synthetic audio</button><canvas id="c" width="800" height="500"></canvas><script>let n=0;setInterval(()=>{const x=c.getContext("2d");x.fillStyle="white";x.fillRect(0,0,800,500);x.fillStyle="black";x.font="24px sans-serif";x.fillText("Frame "+n++,20,50);},33)</script></body></html>';
 await send('Page.navigate',{url:'data:text/html,'+encodeURIComponent(html)},sessionId);await Bun.sleep(300);
 await send('Page.bringToFront',{},sessionId);
 const targets=await send('Target.getTargets',{filter:[{type:'tab',exclude:false},{exclude:true}]});
 const tab=targets.targetInfos.find((t:any)=>t.url.startsWith('data:text/html,'));
 if(!tab)throw Error('No tab target');
 await send('Extensions.triggerAction',{id:loaded.id,targetId:tab.targetId});
 await Bun.sleep(300);
 const allTargets=await send('Target.getTargets');
 const worker=allTargets.targetInfos.find((t:any)=>t.type==='service_worker'&&t.url.startsWith('chrome-extension://'+loaded.id+'/'));
 if(!worker)throw Error('Extension worker not found');
 const {sessionId:workerSession}=await send('Target.attachToTarget',{targetId:worker.targetId,flatten:true});
 let toneStarted=false;
 for(let i=0;i<60;i++){
  const {data}=await send('Extensions.getStorageItems',{id:loaded.id,storageArea:'session',keys:['probe']},workerSession);
  if(data.probe?.stage==='captured'&&!toneStarted){
   console.log(JSON.stringify({capture:data.probe}));
   await send('Input.dispatchMouseEvent',{type:'mousePressed',x:60,y:40,button:'left',clickCount:1},sessionId);
   await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:60,y:40,button:'left',clickCount:1},sessionId);toneStarted=true;
   console.log(JSON.stringify({tone:await send('Runtime.evaluate',{expression:'({state:window.ac?.state, time:window.ac?.currentTime})',returnByValue:true},sessionId)}));
  }
  if(['complete','failed'].includes(data.probe?.stage)){console.log(JSON.stringify({result:data.probe,toneStarted}));if(data.probe.stage==='failed')process.exitCode=1;break;}
  if(i===59)throw Error('Probe timeout');await Bun.sleep(200);
 }
 await send('Browser.close').catch(()=>{});
}finally{ws?.close();chrome.kill();await chrome.exited;await Bun.sleep(300);await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
