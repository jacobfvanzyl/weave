"""Own one bounded CEF sandbox/packaging probe; keep product state untouched."""
from pathlib import Path
import subprocess,os,sys,time,json,urllib.request,signal,shlex
r=Path(__file__).resolve().parent;b=r/'.build';host=sys.argv[1];mode=sys.argv[2] if len(sys.argv)>2 else 'sandbox';e=r/'evidence'/(f'{host}-{mode}'+('-'+sys.argv[3] if len(sys.argv)>3 else ''));e.mkdir(exist_ok=True);procs=[];files=[]
profile_key=os.environ.get('FOUNDATION_PROFILE',f'profile-{mode}-{sys.argv[3] if len(sys.argv)>3 else "initial"}')
def spawn(args,name,env=None):
 f=(e/name).open('w');files.append(f);p=subprocess.Popen(args,stdout=f,stderr=subprocess.STDOUT,env=env,start_new_session=True);procs.append(p);return p
def ssh(cmd):return ['ssh','-o','BatchMode=yes','admin@bazzite',cmd]
try:
 if host=='mac':
  canary=b/'canary.txt';canary.write_text('task-owned sandbox canary\n');canary.chmod(0o600)
  fixture=spawn(['python3',str(r/'fixture-server.py')],'fixture.log')
  env=dict(os.environ,FOUNDATION_CANARY=str(canary));
  if mode=='control':env['FOUNDATION_UNSANDBOXED']='1'
  server=spawn([str(b/'CEFFoundation.app/Contents/MacOS/CEFRFB'),'127.0.0.1','15931','480',str(b/profile_key),'http://127.0.0.1:19380/fixture.html'],'host.log',env)
 else:
  root='/var/home/admin/weave-cef-foundation'
  fixture=spawn(ssh(f'cd {root} && echo $$ > fixture.pid && exec python3 fixture-server.py'),'fixture.log')
  time.sleep(.3);fixturepid=int(subprocess.check_output(ssh(f'cat {root}/fixture.pid'),text=True).strip())
  envpart='FOUNDATION_UNSANDBOXED=1 ' if mode=='control' else ''
  if os.environ.get('FOUNDATION_TWO_PAGES'):envpart+='FOUNDATION_TWO_PAGES=1 '
  extra=' --disable-setuid-sandbox' if mode=='userns' else ''
  server=spawn(ssh(f'cd {root}/runtime && echo $$ > {root}/host.pid && exec env -u DISPLAY {envpart}FOUNDATION_CANARY={root}/canary.txt CEF_RESOURCES={root}/runtime LD_LIBRARY_PATH={root}/runtime ./cef-foundation 127.0.0.1 15931 480 {root}/{shlex.quote(profile_key)} http://127.0.0.1:19380/fixture.html --ozone-platform=headless --password-store=basic --no-first-run --no-default-browser-check{extra}'),'host.log')
  tunnel=spawn(['ssh','-N','-o','ExitOnForwardFailure=yes','-L','19329:127.0.0.1:19329','-L','15931:127.0.0.1:15931','admin@bazzite'],'tunnel.log')
  time.sleep(1)
  hostpid=int(subprocess.check_output(ssh(f'cat {root}/host.pid'),text=True).strip())
 for _ in range(40):
  time.sleep(.5)
  if server.poll() is not None:raise RuntimeError('CEF exited early')
  try:
   v=json.load(urllib.request.urlopen('http://127.0.0.1:19329/json/version',timeout=1));(e/'version.json').write_text(json.dumps(v,indent=2))
   expected=2 if os.environ.get('FOUNDATION_TWO_PAGES') else 1
   if (e/'host.log').read_text().count(chr(34)+'event'+chr(34)+':'+chr(34)+'loaded'+chr(34))>=expected:break
  except Exception:pass
 else:raise RuntimeError('CEF readiness timeout')
 (e/'run.json').write_text(json.dumps({'host':host,'mode':mode,'pid':server.pid,'remotePid':locals().get('hostpid'),'audio':False,'startedAt':time.time()},indent=2))
 print('READY',host,mode,flush=True)
 for _ in range(450):
  time.sleep(1)
  if (e/'STOP').exists() or server.poll() is not None:break
finally:
 if host=='linux' and 'fixturepid' in locals():subprocess.run(ssh(f'kill -TERM {fixturepid}'),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 if host=='linux' and 'hostpid' in locals():subprocess.run(ssh(f'kill -TERM {hostpid}'),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 if host=='linux' and 'server' in locals():
  try:server.wait(timeout=15)
  except subprocess.TimeoutExpired:
   (e/'remote-shutdown-timeout.json').write_text(json.dumps({'pid':hostpid,'graceSeconds':15}))
   subprocess.run(ssh(f'kill -KILL {hostpid}'),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 shutdown=[]
 for p in reversed(procs):
  forced=False
  if p.poll() is None:
   p.terminate()
   try:p.wait(timeout=10)
   except subprocess.TimeoutExpired:forced=True;os.killpg(p.pid,signal.SIGKILL);p.wait()
  shutdown.append({"pid":p.pid,"exit":p.returncode,"forced":forced})
 (e/"shutdown.json").write_text(json.dumps(shutdown,indent=2))
 for f in files:f.close()
