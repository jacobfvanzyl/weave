import { expect, it, vi } from 'vitest';
import { BrowserViewConnection } from './browser-view-connection';
import type { NativeBrowserBridge, NativeBrowserEvent } from './native-browser';
const page={pageId:crypto.randomUUID(),profileId:crypto.randomUUID(),generation:crypto.randomUUID(),title:'Test',url:'about:blank',available:true,width:800,height:600};
function fixture() {
  let event:(event:NativeBrowserEvent)=>void=()=>{}, epoch=0;
  const rpc=vi.fn(async(method:string,args:any)=> {
    if(method==='browser.page.view.attach')return {viewId:'view',ticket:'ticket'};
    if(method==='browser.page.view.focus'||method==='browser.page.view.resize')return {...args,focusEpoch:++epoch,generation:page.generation};
    return {};
  });
  const native:NativeBrowserBridge={create:vi.fn(async()=>({surfaceId:'native'})),connect:vi.fn(async()=>{}),control:vi.fn(async()=>{}),layout:vi.fn(async()=>{}),close:vi.fn(async()=>{}),addListener:vi.fn(async(_name,listener)=>{event=listener;return{remove:vi.fn(async()=>{})};})};
  const client={browserRequest:rpc,browserDisplay:()=>({url:'ws://host/browser/rfb',authorize:async()=>({}),authenticated:()=>{}})};
  const errors=vi.fn(),connection=new BrowserViewConnection(client as any,page,errors,native);
  const frame=(width:number,height:number)=>event({surfaceId:'native',kind:'frame',width,height});
  return{rpc,native,errors,connection,frame};
}
it('holds input until the native framebuffer matches the acknowledged focus viewport',async()=>{
  const f=fixture();
  await f.connection.start();
  f.connection.layout({x:0,y:0,width:1000,height:800,focused:false,visible:true,dim:0});
  await f.connection.activate();
  f.frame(800,600);
  const input=f.connection.input('Input.insertText',{text:'hello'});
  await new Promise(resolve=>setTimeout(resolve,25));
  expect(f.rpc.mock.calls.some(([method])=>method==='browser.page.view.input')).toBe(false);
  f.frame(1000,800);await input;
  expect(f.rpc).toHaveBeenLastCalledWith('browser.page.view.input',expect.objectContaining({focusEpoch:1,arguments:{text:'hello'}}));
  await f.connection.close();
});
it('releases the native display immediately even when Portal detach is stalled',async()=>{
  const f=fixture();await f.connection.start();
  let finish!:()=>void;
  f.rpc.mockImplementation(async(method)=>method==='browser.page.view.detach'?await new Promise(resolve=>{finish=()=>resolve({});}):{});
  const close=f.connection.close();
  expect(f.native.close).toHaveBeenCalledWith({surfaceId:'native'});
  finish();await close;
  expect(f.rpc.mock.calls.some(([method])=>method==='browser.pane.close')).toBe(false);
});
it('a late attachment after disposal is detached without connecting the native WebSocket',async()=>{
  const f=fixture();let finish!:(value:any)=>void;
  f.rpc.mockImplementation(async(method)=>method==='browser.page.view.attach'?await new Promise(resolve=>{finish=resolve;}):{});
  const start=f.connection.start();while(!finish)await Promise.resolve();
  await f.connection.close();finish({viewId:'late',ticket:'late'});await start;
  expect(f.native.connect).not.toHaveBeenCalled();
  expect(f.rpc).toHaveBeenCalledWith('browser.page.view.detach',{viewId:'late'});
});

it('does not replay a pointer gesture against content that reflowed during focus handoff',async()=>{
  const f=fixture();await f.connection.start();
  f.connection.layout({x:0,y:0,width:1000,height:800,focused:false,visible:true,dim:0});
  f.frame(800,600);
  const claim=f.connection.activate();
  const oldClick=f.connection.input('Input.dispatchMouseEvent',{type:'mousePressed',x:50,y:60,button:'left'});
  await claim;f.frame(1000,800);await oldClick;
  expect(f.rpc.mock.calls.some(([method])=>method==='browser.page.view.input')).toBe(false);
  await f.connection.input('Input.dispatchMouseEvent',{type:'mousePressed',x:50,y:60,button:'left'});
  expect(f.rpc).toHaveBeenLastCalledWith('browser.page.view.input',expect.objectContaining({arguments:expect.objectContaining({type:'mousePressed'})}));
  await f.connection.close();
});
