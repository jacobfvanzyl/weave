"""Bounded two-client/reconnect test. All servers bind loopback; Linux via SSH tunnel."""
import json,os,pathlib,subprocess,time,concurrent.futures
ROOT=pathlib.Path(__file__).resolve().parent
BUILD=ROOT/'.build'
EVIDENCE=ROOT/'evidence'

def run(host,multi):
 name=host+('-multi' if multi else '-default'); logs={}; procs=[]
 port=15902 if multi else 15901
 env=os.environ.copy();env.pop('SPICE_DEBUG_ALLOW_MC',None)
 if multi:env['SPICE_DEBUG_ALLOW_MC']='1'
 args=[str(BUILD/'server-mac'),'127.0.0.1',str(port),'24']
 if host=='linux':
  args=['ssh','-o','ExitOnForwardFailure=yes','-L',f'{port+10}:127.0.0.1:{port}','admin@bazzite',('SPICE_DEBUG_ALLOW_MC=1 ' if multi else 'env -u SPICE_DEBUG_ALLOW_MC ')+'/var/home/admin/weave-framebuffer-spike/server-linux 127.0.0.1 '+str(port)+' 24'];port+=10
 def launch(label,cmd,childenv=None):
  f=open(EVIDENCE/f'{name}-{label}.jsonl','w');logs[label]=f;p=subprocess.Popen(cmd,stdout=f,stderr=subprocess.STDOUT,env=childenv);procs.append((label,p));return p
 try:
  server=launch('server',args,env);time.sleep(1)
  launch('viewer-a',[str(BUILD/'client-mac'),'127.0.0.1',str(port),'19'])
  time.sleep(4)
  b=launch('viewer-b',[str(BUILD/'client-mac'),'127.0.0.1',str(port),'6'])
  b.wait(timeout=10);time.sleep(1)
  launch('viewer-b-reconnected',[str(BUILD/'client-mac'),'127.0.0.1',str(port),'5'])
  outcomes={label:p.wait(timeout=28) for label,p in procs}
 finally:
  for _,p in procs:
   if p.poll() is None:p.terminate()
  for f in logs.values():f.close()
 return name,outcomes
results={}
# Cases sequential: same surface producer, isolated ports and bounded processes.
for host in ['mac','linux']:
 for multi in [False,True]:
  name,result=run(host,multi);results[name]=result;print(name,result,flush=True)
(EVIDENCE/'process-results.json').write_text(json.dumps(results,indent=2)+'\n')
