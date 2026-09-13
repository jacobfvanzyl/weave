"""One bounded run; use sequentially to avoid benchmark contention."""
from pathlib import Path
import subprocess,time,os,json,sys,urllib.request,shlex,hashlib
r=Path(__file__).resolve().parent;b=r/'.build';e=r/'evidence';host,transport,dpr=sys.argv[1:4];label=f'{host}-{transport}-dpr{dpr}'+('-'+sys.argv[4] if len(sys.argv)>4 else '');run=e/label;run.mkdir(exist_ok=True)
ipad=os.environ.get('BENCH_CLIENT')=='ipad';device='E997A944-1F31-50BB-8A82-3481C1CDA2DF'
remote='/var/home/admin/weave-remoting-comparison';rfbremote='/var/home/admin/weave-rfb-spike';env=dict(os.environ,BENCH_DPR=dpr);procs=[];files=[]
def spawn(args,path,env=None):
 f=path.open('w');files.append(f);p=subprocess.Popen(args,stdout=f,stderr=subprocess.STDOUT,env=env);procs.append(p);return p
def ssh(command):return ['ssh','-o','BatchMode=yes','admin@bazzite',command]
def stop(p):
 if p.poll() is None:
  p.terminate()
  try:p.wait(timeout=8)
  except subprocess.TimeoutExpired:p.kill();p.wait()
try:
 if host=='linux':
  spawn(ssh('python3 '+remote+'/measure-host.py 1 1'),b/'remote-readiness.log').wait(timeout=10)
 if transport=='rfb':
  ip='100.97.206.8' if host=='mac' else '100.79.27.114';port='15921'
  if host=='mac':args=[str(b/'CEFBench.app/Contents/MacOS/CEFRFB'),ip,port,'170',str(b/f'cef-mac-dpr{dpr}'),(r/'page.html').as_uri()]
  else:args=ssh(f'cd {rfbremote}/cef-runtime && echo $$ > {remote}/.build/host.pid && exec env -u DISPLAY BENCH_DPR={dpr} CEF_RESOURCES={rfbremote}/cef-runtime LD_LIBRARY_PATH={rfbremote}/cef-runtime ./cef-host-bench {ip} {port} 170 {remote}/.build/cef-dpr{dpr} file://{remote}/page.html --ozone-platform=headless --password-store=basic --no-first-run --no-default-browser-check')
  server=spawn(args,run/'host.log',env);time.sleep(3)
  if host=='linux':tunnel=spawn(['ssh','-N','-o','ExitOnForwardFailure=yes','-L','19231:127.0.0.1:19229','admin@bazzite'],run/'tunnel.log');time.sleep(.5)
  nativeEnv=dict(env,RFB_HOST=ip,RFB_PORT=port,BENCH_SNAPSHOT=str(run/'received.png'))
  nativeArgs=[str(b/'RFBBench.app/Contents/MacOS/RFBBench')]
 else:
  if host=='mac':args=['bun',str(r/'host.ts')];env.update(SPIKE_PORT='9897',SPIKE_BIND='127.0.0.1',SPIKE_HOST='127.0.0.1',CHROME_BINARY=str(b/'chrome-wrapper'),BENCH_BUILD=str(b))
  else:args=ssh(f'cd {remote} && echo $$ > .build/host.pid && exec env BENCH_DPR={dpr} SPIKE_PORT=9897 SPIKE_BIND=100.79.27.114 SPIKE_HOST=100.79.27.114 CHROME_BINARY={remote}/chrome-wrapper BENCH_BUILD={remote}/.build BENCH_ROOT={remote} BENCH_EXTENSION={os.environ.get('BENCH_EXTENSION','extension')} ./host-linux')
  server=spawn(args,run/'host.log',env)
  for _ in range(30):
   time.sleep(1)
   if '"event":"ready"' in (run/'host.log').read_text():break
   if server.poll() is not None:raise RuntimeError('WebRTC Host exited')
  else:raise RuntimeError('WebRTC Host timeout')
  config=b/'connection.json'
  if host=='linux':
   config=b/'linux-connection.json';subprocess.run(['scp','admin@bazzite:'+remote+'/.build/connection.json',str(config)],check=True,stdout=subprocess.DEVNULL)
  nativeEnv=dict(env,WEAVE_BROWSER_SPIKE_CONFIG=str(config),BENCH_SNAPSHOT=str(run/'received.png'))
  nativeArgs=[str(b/'WebRTCBench.app/Contents/MacOS/WebRTCBench')]
 if host=='mac':hostpid=server.pid
 else:hostpid=int(subprocess.check_output(ssh(f'cat {remote}/.build/host.pid'),text=True).strip())
 resourceArgs=['python3',str(r/'measure-host.py'),str(hostpid),'120'] if host=='mac' else ssh(f'python3 {remote}/measure-host.py {hostpid} 120')
 # Start resource sampling after any device installation.
 if ipad:
  import shutil
  kind='RFB' if transport=='rfb' else 'WebRTC';scheme='RFBSpike' if transport=='rfb' else 'BrowserSpike'
  if transport=='webrtc':shutil.copy2(config,b/'ipad-resources/connection.json')
  with (run/'ipad-build.log').open('w') as log:subprocess.run(['xcodebuild','-project',str(b/(kind+'Bench.xcodeproj')),'-scheme',scheme,'-configuration','Debug','-destination','generic/platform=iOS','-derivedDataPath',str(b/('ipad-'+transport)),'-allowProvisioningUpdates','build'],stdout=log,stderr=subprocess.STDOUT,check=True)
  with (run/'ipad-install.log').open('w') as log:subprocess.run(['xcrun','devicectl','device','install','app','--device',device,str(b/('ipad-'+transport)/'Build/Products/Debug-iphoneos'/(scheme+'.app'))],stdout=log,stderr=subprocess.STDOUT,check=True)
  childEnv={'RFB_HOST':ip,'RFB_PORT':port} if transport=='rfb' else {'BENCH_RUN':'1'}
  childEnv.update({k:v for k,v in os.environ.items() if k in ['BENCH_NO_PRESENT','BENCH_MORE_ACKS']})
  nativeArgs=['xcrun','devicectl','device','process','launch','--device',device,'--terminate-existing','--console','--environment-variables',json.dumps(childEnv),'com.veezee.browser-spike']
 resources=spawn(resourceArgs,run/'host-resources.jsonl')
 client=spawn(nativeArgs,run/'client.jsonl',nativeEnv)
 (run/'configuration.json').write_text(json.dumps({'host':host,'transport':transport,'dpr':int(dpr),'client':'iPadOS' if ipad else 'macOS','rfbNoPresent':os.environ.get('BENCH_NO_PRESENT','0'),'rfbMoreAcks':os.environ.get('BENCH_MORE_ACKS','0'),'extensionVariant':os.environ.get('BENCH_EXTENSION','extension'),'viewportCSS':[960,640],'audio':False,'softwareRendering':True,'sourceSha256':{name:hashlib.sha256((r/name).read_bytes()).hexdigest() for name in ['RFBApp.m','BenchRFB.h','cef-host.cc','page.html','run.py']},'hostPid':hostpid,'clientPid':client.pid,'startedAt':time.time()},indent=2)+'\n')
 deadline=time.monotonic()+120;captured=False
 while client.poll() is None and time.monotonic()<deadline:
  time.sleep(.5)
  content=(run/'client.jsonl').read_text()
  if not captured and '"event":"snapshot"' in content:
   captured=True
   if transport=='rfb':
    result=subprocess.run(['bun',str(r/'reference.ts'),'19229' if host=='mac' else '19231',str(run/'reference.png')],capture_output=True,text=True,timeout=10)
    (run/'reference-state.json').write_text(result.stdout);(run/'reference-error.log').write_text(result.stderr)
   else:
    configData=json.loads(config.read_text());url=configData['endpoint'].replace('ws://','http://').replace('/signal','/control')
    req=urllib.request.Request(url,data=json.dumps({'type':'reference'}).encode(),headers={'Authorization':'Bearer '+configData['token'],'Content-Type':'application/json'})
    import base64
    data=json.load(urllib.request.urlopen(req,timeout=10));(run/'reference.png').write_bytes(base64.b64decode(data['image']['data']));(run/'reference-state.json').write_text(json.dumps(data['state']['result']['value'])+'\n')
 if ipad and captured:
  with (run/'ipad-copy.log').open('w') as log:subprocess.run(['xcrun','devicectl','device','copy','from','--device',device,'--source','tmp/'+('rfb' if transport=='rfb' else 'webrtc')+'-quality.png','--destination',str(run/'received.png'),'--domain-type','appDataContainer','--domain-identifier','com.veezee.browser-spike'],stdout=log,stderr=subprocess.STDOUT,check=True)
 stop(client);stop(resources)
 print(label,'client exit',client.returncode,'reference',captured,flush=True)
 (run/'exit.json').write_text(json.dumps({'client':client.returncode,'reference':captured})+'\n')
 if client.returncode!=0 or not captured:raise RuntimeError('Native run failed; see retained evidence')
finally:
 # Graceful ownership-scoped server stop. Killing SSH alone would leave its child on Linux.
 if host=='linux' and 'hostpid' in locals():subprocess.run(ssh(f'kill -TERM {hostpid}'),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 for p in reversed(procs):stop(p)
 for f in files:f.close()
