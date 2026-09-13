from pathlib import Path
import subprocess,time,json
r=Path(__file__).resolve().parent;b=r/'.build';e=r/'evidence'
subprocess.run(['clang','-I'+str(b/'libvncserver-LibVNCServer-0.9.15/include'),'-I'+str(b/'lib-mac/include'),str(r/'server.c'),str(b/'lib-mac/libvncserver.a'),'-lz','-lpthread','-o',str(b/'server-mac')],check=True)
subprocess.run(['scp',str(r/'server.c'),'admin@bazzite:/var/home/admin/weave-rfb-spike/server.c'],check=True)
subprocess.run(['ssh','admin@bazzite','cd /var/home/admin/weave-rfb-spike && cc -g -I sysroot/usr/include server.c -l:libvncserver.so.1 -o server-linux-fixed'],check=True)
results={}
for host in ['mac','linux']:
 port=15913 if host=='mac' else 15914
 args=[str(b/'server-mac'),'127.0.0.1',str(port),'18'] if host=='mac' else ['ssh','admin@bazzite','/var/home/admin/weave-rfb-spike/server-linux-fixed 100.79.27.114 '+str(port)+' 18']
 address='127.0.0.1' if host=='mac' else '100.79.27.114';handles=[];procs=[]
 def spawn(name,args):
  f=(e/(host+'-'+name+'.log')).open('w');handles.append(f);p=subprocess.Popen(args,stdout=f,stderr=subprocess.STDOUT);procs.append((name,p));return p
 server=spawn('synthetic-server',args);time.sleep(.5)
 a=spawn('synthetic-a',[str(b/'probe-mac'),address,str(port),'14','2','1000','700','3'])
 time.sleep(4)
 bb=spawn('synthetic-b',[str(b/'probe-mac'),address,str(port),'4','1','800','1000','2']);bb.wait(timeout=8)
 time.sleep(.5)
 spawn('synthetic-b-reconnect',[str(b/'probe-mac'),address,str(port),'4','1','960','640','2'])
 results[host]={name:p.wait(timeout=22) for name,p in procs}
 for f in handles:f.close()
 print(host,results[host],flush=True)
(e/'synthetic-processes.json').write_text(json.dumps(results,indent=2)+'\n')
