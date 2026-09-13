"""Bounded stdio MCP client for a pinned maintained tool server, fixture only."""
from pathlib import Path
import subprocess,threading,queue,json,sys,os,time,re
r=Path(__file__).resolve().parent;e=r/'evidence'/sys.argv[1];e.mkdir(exist_ok=True);log=(e/'mcp-results.jsonl').open('w');err=(e/'mcp-stderr.log').open('w');pending=queue.Queue();counter=0
p=subprocess.Popen(['node',str(r/'.build/tools/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'),'--browser-url=http://127.0.0.1:19329','--no-usage-statistics','--no-performance-crux','--no-page-id-routing','--workspace='+str(e)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err,text=True,env=dict(os.environ,CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS='1'))
def read():
 for line in p.stdout:
  try:pending.put(json.loads(line))
  except ValueError:pass
 pending.put({'closed':True})
threading.Thread(target=read,daemon=True).start()
def send(method,params={},notify=False):
 global counter
 counter+=1;message={'jsonrpc':'2.0','method':method,'params':params}
 if not notify:message['id']=counter
 p.stdin.write(json.dumps(message)+'\n');p.stdin.flush()
 if notify:return
 until=time.monotonic()+45
 while time.monotonic()<until:
  m=pending.get(timeout=max(.1,until-time.monotonic()))
  if m.get('id')==counter:
   log.write(json.dumps({'method':method,'params':params,'response':m})+'\n');log.flush();return m
  if m.get('closed'):raise RuntimeError('MCP exited')
 raise TimeoutError(method)
def call(name,args={}):
 out=send('tools/call',{'name':name,'arguments':args});result=out.get('result',{});print(name,'ERROR' if 'error' in out or result.get('isError') else 'OK',flush=True);return result
try:
 init=send('initialize',{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'weave-cef-foundation-validation','version':'0.1'}});send('notifications/initialized',notify=True)
 catalog=send('tools/list');(e/'mcp-tools.json').write_text(json.dumps(catalog,indent=2))
 if len(sys.argv)>2 and sys.argv[2]=='catalog':
  print(json.dumps(catalog));sys.exit(0)
 pages=call('list_pages')
 call('navigate_page',{'type':'url','url':'http://127.0.0.1:19380/fixture.html?mcp=1','timeout':8000})
 snapshot=call('take_snapshot');text='\n'.join(c.get('text','') for c in snapshot.get('content',[]))
 name=re.search(r'uid=(\S+) textbox "Name"',text);button=re.search(r'uid=(\S+) button "Test click"',text)
 if name:call('fill',{'uid':name.group(1),'value':'CEF MCP verified'})
 if button:call('click',{'uid':button.group(1)})
 call('evaluate_script',{'function':"() => { localStorage.setItem('foundation','persistent'); return {title:document.title,clicks:window.clicks,name:document.querySelector('#name').value,network:window.networkResult}; }"})
 call('list_console_messages');network=call('list_network_requests')
 nt='\n'.join(c.get('text','') for c in network.get('content',[]));request=re.search(r'reqid=(\d+)[^\n]*api/ping',nt)
 if request:call('get_network_request',{'reqid':int(request.group(1))})
 call('take_screenshot',{'format':'png','filePath':str(e/'mcp-screenshot.png')})
 call('performance_start_trace',{'reload':False,'autoStop':False})
 time.sleep(1)
 call('performance_stop_trace',{'filePath':str(e/'mcp-trace.json.gz')})
 new=pages if len(sys.argv)>2 and sys.argv[2]=='managed' else call('new_page',{'url':'http://127.0.0.1:19380/fixture.html?new-page=1','background':True,'timeout':8000})
 nt='\n'.join(c.get('text','') for c in new.get('content',[]));created=re.search(r'^(\d+):[^\n]*(?:new-page|native-second)=1',nt,re.M)
 call('list_pages')
 if created:
  call('select_page',{'pageId':int(created.group(1))});call('evaluate_script',{'function':'() => ({url:location.href,width:innerWidth,height:innerHeight})'})
  call('close_page',{'pageId':int(created.group(1))})
 call('list_pages')
 (e/'mcp-exit.json').write_text(json.dumps({'probeFinished':True,'serverVersion':init.get('result',{}).get('serverInfo')})+'\n')
finally:
 p.terminate()
 try:p.wait(timeout=5)
 except subprocess.TimeoutExpired:p.kill();p.wait()
 log.close();err.close()
