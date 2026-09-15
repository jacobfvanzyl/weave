import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BrowserAgentGateway } from '../src/browser-agent.ts';
import { BrowserGrantStore } from '../src/browser-grants.ts';
import { BrowserServiceClient } from '../src/browser-service/client.ts';
import { serveBrowserService } from '../src/browser-service/service.ts';
import { AgentProcess } from '../src/agent-process.ts';
import { ACP_INITIALIZE_PARAMS } from '../src/provider-protocol.ts';
const configPath = process.env.PORTAL_CONFIG;
if (!configPath || !process.env.CEF_BINARY) throw new Error('PORTAL_CONFIG and CEF_BINARY are required; this opt-in acceptance invokes the configured Codex ACP provider');
const root=await mkdtemp('/tmp/weave-real-acp-');
const cef=process.env.CEF_BINARY!;
const owner=await serveBrowserService({stateDirectory:root,binary:'/unused',cefBinary:cef});
const backend=new BrowserServiceClient(root,'/unused',cef);
const grants=await BrowserGrantStore.open(root),threadId=crypto.randomUUID();
const profile=(await backend.profile('browser.profile.create',{name:'Provider acceptance'})).profile;
const fixture=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('<title>Weave MCP acceptance</title><h1>Native shared page 7284</h1>',{headers:{'content-type':'text/html'}})});
await backend.managedPage('page.create',{profileId:profile.profileId,pageId:crypto.randomUUID(),url:`http://127.0.0.1:${fixture.port}`});
await grants.set(threadId,[profile.profileId],0,async()=>{});
const gateway=new BrowserAgentGateway({grants,thread:()=>({threadId,status:'active'} as any),backend,profiles:async()=>[profile],create:async()=>{throw new Error('Read-only acceptance')},close:async()=>{throw new Error('Read-only acceptance')}},{node:process.env.BROWSER_NODE ?? Bun.which('node')!,script:fileURLToPath(new URL('../browser-tools/runner.mjs',import.meta.url))});
const config=await Bun.file(configPath).json();
let agent:AgentProcess|undefined;let final='';
const timer=setTimeout(()=>{console.error('PROBE TIMEOUT');process.exit(1)},180000);
try{
 agent=new AgentProcess(config.agents.find((a:any)=>a.agentId==='codex'),root,message=>{
  if(message.method==='session/request_permission'&&message.id!==undefined){void agent!.send({jsonrpc:'2.0',id:message.id,result:{outcome:{outcome:'cancelled'}}});return;}
  const u=(message.params as any)?.update;
  if(u?.sessionUpdate==='agent_message_chunk'){final+=u.content.text;console.log('TEXT',u.content.text)}
  else if(u?.sessionUpdate==='tool_call')console.log('TOOL',u.title);
  else if(u?.sessionUpdate==='tool_call_update')console.log('TOOLSTATUS',u.status);
 });
 await agent.request('initialize',ACP_INITIALIZE_PARAMS);
 const s=await agent.request('session/new',{cwd:root,mcpServers:gateway.servers(threadId)}) as any;
 console.log('SESSION',s.sessionId);
 await agent.request('session/prompt',{sessionId:s.sessionId,prompt:[{type:'text',text:process.env.PROBE_PROMPT??'Can you access the open browser pane in Weave? Report its title and first heading without changing anything.'}]});
 console.log('FINAL',final);
 if(!final.includes('7284'))throw new Error('Provider did not inspect the granted native page');
 console.log('REAL PROVIDER ACCEPTANCE PASSED');
}finally{
 clearTimeout(timer);
 try { await agent?.close(); }
 finally { await gateway.close(); backend.dispose(); await owner.close(); await fixture.stop(true); await rm(root,{recursive:true,force:true}); }
}
