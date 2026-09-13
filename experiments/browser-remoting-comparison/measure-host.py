# Sample only a specified process and its descendants. CPU is cumulative process time.
import subprocess,time,json,sys,os
from pathlib import Path
pid=int(sys.argv[1]);duration=float(sys.argv[2])
start=time.monotonic();retained={};ticks=os.sysconf("SC_CLK_TCK")
def seconds(s):
 d=0
 if '-' in s:d,s=s.split('-',1);d=int(d)*86400
 p=list(map(float,s.split(':')));return d+sum(v*60**i for i,v in enumerate(reversed(p)))
while time.monotonic()-start<duration:
 rows={}
 for line in subprocess.check_output(['ps','-axo','pid=,ppid=,time=,rss='],text=True).splitlines():
  a=line.split()
  if len(a)==4:
   proc=int(a[0]);cpu=seconds(a[2])
   if sys.platform=='linux':
    try:
     stat=Path(f'/proc/{proc}/stat').read_text().rsplit(')',1)[1].split();cpu=(int(stat[11])+int(stat[12]))/ticks
    except (FileNotFoundError,ProcessLookupError):continue
   rows[proc]=(int(a[1]),cpu,int(a[3])*1024)
 family={pid}
 for _ in range(10):
  expanded=family|{p for p,(parent,_,_) in rows.items() if parent in family}
  if expanded==family:break
  family=expanded
 present=[p for p in family if p in rows]
 for p in present:retained[p]=rows[p][1]
 print(json.dumps({'wall':time.time(),'elapsed':time.monotonic()-start,'root':pid,'processes':len(present),'cpuSeconds':sum(retained.values()),'cpuMethod':'retained per-PID cumulative CPU; Linux clock ticks, Mac ps time','rssBytes':sum(rows[p][2] for p in present)}),flush=True)
 if pid not in rows:break
 time.sleep(1)
