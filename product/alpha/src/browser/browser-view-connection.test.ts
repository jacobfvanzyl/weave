import { expect, it, vi } from 'vitest';
import { BrowserViewConnection } from './browser-view-connection';
import type { NativeBrowserBridge, NativeBrowserEvent } from './native-browser';
import { wheelPixels } from './browser-wheel';
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

async function scrollingFixture() {
  const f = fixture(); await f.connection.start();
  f.connection.layout({ x:0, y:0, width:800, height:600, focused:false, visible:true, dim:0 });
  f.frame(800,600); await f.connection.activate();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const original = f.rpc.getMockImplementation()!;
  let first = true;
  f.rpc.mockImplementation(async (method, args) => {
    if (method === 'browser.page.view.input' && first) { first = false; entered(); await blocked; }
    return original(method, args);
  });
  const wheel = (deltaY: number, extra = {}) => f.connection.input('Input.dispatchMouseEvent', { type:'mouseWheel', x:100, y:100, deltaX:0, deltaY, modifiers:0, ...extra });
  const inFlight = wheel(1); await started;
  const inputs = () => f.rpc.mock.calls.filter(([method]) => method === 'browser.page.view.input').map(([,args]) => args.arguments);
  return { ...f, release, inFlight, wheel, inputs };
}

it('keeps the first wheel prompt and bounds a burst behind a stalled RPC without losing displacement', async () => {
  const f = await scrollingFixture();
  const burst = Array.from({ length:1000 }, () => f.wheel(.5, { deltaX:.25 }));
  expect(f.inputs()).toHaveLength(1);
  f.release(); await Promise.all([f.inFlight, ...burst]);
  expect(f.inputs()).toEqual([
    expect.objectContaining({ deltaX:0, deltaY:1 }),
    expect.objectContaining({ deltaX:250, deltaY:500 }),
  ]);
  expect(f.errors).not.toHaveBeenCalledWith(expect.objectContaining({ error:expect.any(String) }));
  await f.connection.close();
});

it('preserves reversals, pointer targets, modifiers and button/key boundaries', async () => {
  const f = await scrollingFixture();
  const pending = [f.wheel(3), f.wheel(4), f.wheel(-2), f.wheel(-2, { x:101 }), f.wheel(-2, { x:101, modifiers:8 }),
    f.connection.input('Input.dispatchKeyEvent', { type:'rawKeyDown', key:'Shift' }), f.wheel(5),
    f.connection.input('Input.dispatchMouseEvent', { type:'mousePressed', x:100, y:100, button:'left' }), f.wheel(6)];
  f.release(); await Promise.all([f.inFlight, ...pending]);
  expect(f.inputs().map(args => args.type === 'mouseWheel' ? args.deltaY : args.type)).toEqual([1,7,-2,-2,-2,'rawKeyDown',5,'mousePressed',6]);
  await f.connection.close();
});

it('a focus claim seals pending wheels and hidden input is not replayed after focus returns', async () => {
  const f = await scrollingFixture();
  const old = f.wheel(10);
  f.connection.layout({ x:0, y:0, width:800, height:600, focused:false, visible:false, dim:0 });
  f.connection.layout({ x:0, y:0, width:800, height:600, focused:true, visible:true, dim:0 });
  const current = f.wheel(20);
  f.release(); await Promise.all([f.inFlight, old, current]);
  expect(f.inputs().map(args => args.deltaY)).toEqual([1,20]);
  await f.connection.close();
});

it('does not overflow an accumulated wheel or replay pending input after a rejected authority epoch', async () => {
  const f = await scrollingFixture();
  const pending = [f.wheel(20000), f.wheel(20000)];
  f.release(); await Promise.all([f.inFlight, ...pending]);
  expect(f.inputs().map(args => args.deltaY)).toEqual([1,20000,20000]);
  f.rpc.mockRejectedValueOnce(new Error('Browser view no longer owns the viewport'));
  await f.wheel(3); const count = f.inputs().length;
  await f.wheel(4); expect(f.inputs()).toHaveLength(count);
  await f.connection.close();
});

it('normalizes line/page wheel units without changing pixel-precise trackpad deltas', () => {
  expect(wheelPixels({ deltaX:.25, deltaY:-1.5, deltaMode:0 },24,800)).toEqual({ deltaX:.25, deltaY:-1.5 });
  expect(wheelPixels({ deltaX:1, deltaY:3, deltaMode:1 },24,800)).toEqual({ deltaX:24, deltaY:72 });
  expect(wheelPixels({ deltaX:0, deltaY:-1, deltaMode:2 },24,800)).toEqual({ deltaX:0, deltaY:-800 });
  expect(wheelPixels({ deltaX:1, deltaY:-1, deltaMode:2 },24,800,1200)).toEqual({ deltaX:1200, deltaY:-800 });
});
