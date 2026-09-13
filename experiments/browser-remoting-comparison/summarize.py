from pathlib import Path
import json,math,statistics,sys
r=Path(__file__).resolve().parent
sys.path.insert(0,str(r.parent/'remote-viz-spike/tools'))
from png_pixels import read_png

def rows(p):
 result=[]
 for line in p.read_text().splitlines():
  try:result.append(json.loads(line))
  except ValueError:pass
 return result

def percentile(a,p):
 if not a:return None
 a=sorted(a);i=(len(a)-1)*p;lo=int(i);return a[lo]+(a[min(lo+1,len(a)-1)]-a[lo])*(i-lo)
summary=[]
for path in sorted((r/'evidence').iterdir()):
 if not path.is_dir() or not (path/'exit.json').exists():continue
 cached=path/'summary.json'
 if cached.exists() and '--refresh' not in sys.argv and cached.stat().st_mtime>max(f.stat().st_mtime for f in path.iterdir() if f.name!='summary.json'):
  summary.append(json.loads(cached.read_text()));continue
 data=rows(path/'client.jsonl');cfg=json.loads((path/'configuration.json').read_text())
 if not any('t' in x for x in data):
  out={'run':path.name,**cfg,'exit':json.loads((path/'exit.json').read_text()),'inputLatencyMs':{'n':0},'phases':[],'failure':'No native measurement samples; see client.jsonl'}
  (path/'summary.json').write_text(json.dumps(out,indent=2)+'\n');summary.append(out);continue
 host=rows(path/'host-resources.jsonl');phases=[x for x in data if x.get('event')=='phase'];first=min(x['t'] for x in data if 't' in x);out={'run':path.name,**cfg,'exit':json.loads((path/'exit.json').read_text()),'phases':[]}
 latency=[x['ms'] for x in data if x.get('event')=='latency' and x['phase']==2];out['inputLatencyMs']={'n':len(latency),'p50':percentile(latency,.5),'p95':percentile(latency,.95),'max':max(latency) if latency else None};out['inputTimeouts']=sum(x.get('event')=='input-timeout' for x in data)
 for phase in phases:
  p=phase['phase'];end=next((x['t'] for x in phases if x['t']>phase['t']),None)
  if not end or not 1<=p<=5:continue
  lo=phase['t']+2;hi=end-1
  frames=[x for x in data if x.get('event')=='frame' and lo<=x['t']<=hi];unique=[]
  for f in frames:
   if not unique or f['sequence']!=unique[-1]['sequence']:unique.append(f)
  gaps=[(b['t']-a['t'])*1000 for a,b in zip(unique,unique[1:])]
  samples=[x for x in data if x.get('event')=='stats' and lo<=x['t']<=hi];cpu=None;rss=None;bps=None
  if len(samples)>1:
   a,b=samples[0],samples[-1];cpu=(b['cpuSeconds']-a['cpuSeconds'])/(b['t']-a['t'])*100;rss=statistics.mean(x['rssBytes'] for x in samples)
   if 'rxBytes' in a:bps=(b['rxBytes']-a['rxBytes'])*8/(b['t']-a['t'])
  rtc=[x for x in data if x.get('event')=='rtcStats' and lo<=x['t']<=hi]
  if len(rtc)>1:
   def video(x):return next((v for v in x['rows'] if v['type']=='inbound-rtp' and v.get('kind')=='video'),None)
   a,b=video(rtc[0]),video(rtc[-1])
   if a and b:bps=(b['bytesReceived']-a['bytesReceived'])*8/(rtc[-1]['t']-rtc[0]['t'])
  # Sampling processes start immediately before client; trim boundaries to absorb startup offset.
  hs=[x for x in host if lo-first+1<=x['elapsed']<=hi-first-1];hc=None;hr=None
  if len(hs)>1:hc=(hs[-1]['cpuSeconds']-hs[0]['cpuSeconds'])/(hs[-1]['elapsed']-hs[0]['elapsed'])*100;hr=statistics.mean(x['rssBytes'] for x in hs)
  decode=None;bufferDelay=None
  if len(rtc)>1:
   a,b=video(rtc[0]),video(rtc[-1])
   if a and b and b.get('framesDecoded',0)>a.get('framesDecoded',0):decode=(b['totalDecodeTime']-a['totalDecodeTime'])/(b['framesDecoded']-a['framesDecoded'])*1000
   if a and b and b.get('jitterBufferEmittedCount',0)>a.get('jitterBufferEmittedCount',0):bufferDelay=(b['jitterBufferDelay']-a['jitterBufferDelay'])/(b['jitterBufferEmittedCount']-a['jitterBufferEmittedCount'])*1000
  costs=[x for x in data if lo<=x.get('t',-1)<=hi and x.get('event') in ['receive-cost','presentation-cost','tcp']]
  diagnostics={}
  for key in ['handleMs','handleCpuMs','copyMs','queueMs','submitMs','rttMs','srttMs','rxWindow']:
   values=[x[key] for x in costs if key in x]
   if values:diagnostics[key]={'n':len(values),'mean':statistics.mean(values),'p50':percentile(values,.5),'p95':percentile(values,.95)}
  diagnostics['skippedPresentations']=sum(x.get('event')=='presentation-skipped' and lo<=x.get('t',-1)<=hi for x in data)
  diagnostics['presentationSubmissions']=sum(x.get('event')=='presentation-cost' and lo<=x.get('t',-1)<=hi for x in data)
  out['phases'].append({'rfbDiagnostics':diagnostics,'meanDecodeMs':decode,'meanJitterBufferMs':bufferDelay,'phase':p,'name':['ready','idle','input','scroll','animation','dense'][p],'windowSeconds':hi-lo,'receivedDistinctFPS':(len(unique)-1)/(unique[-1]['t']-unique[0]['t']) if len(unique)>1 else 0,'frameGapP95Ms':percentile(gaps,.95),'receivedMbps':bps/1e6 if bps is not None else None,'clientCPUPercentOneCore':cpu,'clientRSSMiB':rss/1048576 if rss else None,'hostCPUPercentOneCoreApprox':hc,'hostSummedRSSMiBApprox':hr/1048576 if hr else None})
 if (path/'reference.png').exists() and (path/'received.png').exists():
  w,h,ref=read_png(path/'reference.png');ww,hh,pix=read_png(path/'received.png');out['imageSize']=[w,h];out['receivedSize']=[ww,hh]
  if (w,h)==(ww,hh):
   err=0;bad=0;maxerr=0;n=0;fineErr=0;fineBad=0;fineN=0;d=cfg['dpr']
   # Exclude changing measurement marker/header. Compare the static browser content only.
   for y in range(90*d,h):
    for x in range(w):
     errors=[abs(a-b) for a,b in zip(ref(x,y)[:3],pix(x,y)[:3])];e=sum(errors);m=max(errors);err+=e;bad+=m>2;maxerr=max(maxerr,m);n+=1
     if 20*d<=x<460*d and 440*d<=y<560*d:fineErr+=e;fineBad+=m>2;fineN+=1
   out['staticRGB']={'pixels':n,'meanAbsoluteChannelError':err/n/3,'fractionPixelsOver2':bad/n,'maxChannelError':maxerr,'fineTextRegionMeanAbsoluteChannelError':fineErr/fineN/3,'fineTextRegionFractionOver2':fineBad/fineN}
  out['referenceState']=json.loads((path/'reference-state.json').read_text())
 rtc=[x for x in data if x.get('event')=='rtcStats']
 if rtc:
  stats=rtc[-1]['rows'];byid={x['id']:x for x in stats};transport=next((x for x in stats if x['type']=='transport' and x.get('selectedCandidatePairId')),None);pair=byid.get(transport['selectedCandidatePairId']) if transport else next((x for x in stats if x['type']=='candidate-pair' and x.get('nominated') and x.get('bytesReceived',0)>10000),None)
  out['selectedRoute']={key:byid.get(pair.get(key),{}) for key in ['localCandidateId','remoteCandidateId']} if pair else None
  out['audioPlayingObserved']=any(x.get('audioPlaying') for x in rtc)
  out['probeConversionP95Ms']=percentile([x['probeConversionMs'] for x in data if 'probeConversionMs' in x],.95)
 (path/'summary.json').write_text(json.dumps(out,indent=2)+'\n');summary.append(out)
 print(path.name,'latency',out['inputLatencyMs'],'pixels',out.get('staticRGB'),flush=True)
(r/'evidence/summary.json').write_text(json.dumps(summary,indent=2)+'\n')
