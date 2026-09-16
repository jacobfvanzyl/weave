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
  const native:NativeBrowserBridge={clipboard:vi.fn(async()=>({})),create:vi.fn(async()=>({surfaceId:'native'})),connect:vi.fn(async()=>{}),control:vi.fn(async()=>{}),layout:vi.fn(async()=>{}),close:vi.fn(async()=>{}),addListener:vi.fn(async(_name,listener)=>{event=listener;return{remove:vi.fn(async()=>{})};})};
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

it('keeps an overlay display attached while dropping queued and new input without reclaiming the viewport', async () => {
  const f = await scrollingFixture();
  const queued = f.wheel(5);
  const focusCalls = () => f.rpc.mock.calls.filter(([method]) => method === 'browser.page.view.focus').length;
  const claims = focusCalls();
  f.connection.layout({ x:0, y:0, width:800, height:600, focused:true, visible:true, inputBlocked:true, dim:0 });
  await f.connection.activate();
  await f.connection.input('Input.insertText', { text:'dialog typing' });
  f.release(); await Promise.all([f.inFlight, queued]);
  expect(f.inputs()).toHaveLength(1);
  expect(f.native.layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible:true }));
  expect(f.native.close).not.toHaveBeenCalled();
  f.connection.layout({ x:0, y:0, width:800, height:600, focused:true, visible:true, inputBlocked:false, dim:0 });
  await f.connection.input('Input.insertText', { text:'page typing' });
  expect(f.inputs()).toHaveLength(2);
  expect(focusCalls()).toBe(claims);
  await f.connection.close();
});

it('cancels input waiting for a resized frame when an overlay opens', async () => {
  const f = fixture(); await f.connection.start();
  const bounds = { x:0, y:0, width:1000, height:800, focused:true, visible:true, dim:0 };
  f.connection.layout(bounds); await f.connection.activate(); f.frame(800,600);
  const input = f.connection.input('Input.insertText', { text:'pending' });
  await new Promise(resolve => setTimeout(resolve, 25));
  f.connection.layout({ ...bounds, inputBlocked:true });
  await input;
  expect(f.rpc.mock.calls.some(([method]) => method === 'browser.page.view.input')).toBe(false);
  expect(f.errors).not.toHaveBeenCalledWith(expect.objectContaining({ error:expect.any(String) }));
  await f.connection.close();
}, 500);

it('waits for physical Retina pixels while leaving mouse coordinates in logical page units', async () => {
  const f = fixture(); await f.connection.start();
  f.connection.layout({ x:0, y:0, width:800, height:600, deviceScaleFactor:2, focused:false, visible:true, dim:0 });
  f.frame(800,600); await f.connection.activate();
  const stale = f.connection.input('Input.dispatchMouseEvent', { type:'mousePressed', x:50, y:60, button:'left' });
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(f.rpc.mock.calls.some(([method]) => method === 'browser.page.view.input')).toBe(false);
  f.frame(1600,1200); await stale;
  expect(f.rpc.mock.calls.some(([method]) => method === 'browser.page.view.input')).toBe(false);
  await f.connection.input('Input.dispatchMouseEvent', { type:'mousePressed', x:50, y:60, button:'left' });
  expect(f.rpc).toHaveBeenLastCalledWith('browser.page.view.input', expect.objectContaining({ arguments:expect.objectContaining({ x:50, y:60 }) }));
  f.connection.layout({ x:0, y:0, width:800, height:600, deviceScaleFactor:1, focused:true, visible:true, dim:0 });
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(f.rpc).toHaveBeenCalledWith('browser.page.view.resize', expect.objectContaining({ width:800, height:600, deviceScaleFactor:1 }));
  f.frame(800,600); await f.connection.close();
});

it('claims the initial Retina viewport after its creation menu closes, then retains that claim across later overlays', async () => {
  const f = fixture(); await f.connection.start();
  const bounds = { x:0, y:0, width:800, height:600, deviceScaleFactor:2, focused:true, visible:true, inputBlocked:true, dim:0 };
  f.connection.layout(bounds);
  expect(f.rpc.mock.calls.some(([method]) => method === 'browser.page.view.focus')).toBe(false);
  f.connection.layout({ ...bounds, inputBlocked:false });
  await new Promise(resolve => setTimeout(resolve, 25));
  f.frame(1600,1200);
  f.connection.layout(bounds); f.connection.layout({ ...bounds, inputBlocked:false });
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(f.rpc.mock.calls.filter(([method]) => method === 'browser.page.view.focus')).toHaveLength(1);
  await f.connection.close();
});

it('coalesces pending hover positions while preserving click boundaries', async()=>{
  const f=fixture(); await f.connection.start();
  f.connection.layout({x:0,y:0,width:800,height:600,focused:false,visible:true,dim:0});f.frame(800,600);await f.connection.activate();
  const calls: any[]=[];let finish!:()=>void;
  f.rpc.mockImplementation(async(method,args)=>{if(method==='browser.page.view.input'){calls.push(args);if(calls.length===1)await new Promise<void>(resolve=>{finish=resolve;});}return {};});
  const first=f.connection.input('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1,buttons:0});
  await new Promise(resolve=>setTimeout(resolve,0));
  const moves=Array.from({length:100},(_,x)=>f.connection.input('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+2,y:1,buttons:0}));
  const click=f.connection.input('Input.dispatchMouseEvent',{type:'mousePressed',x:101,y:1,buttons:1,button:'left'});
  finish();await Promise.all([first,...moves,click]);
  expect(calls.map(call=>[call.arguments.type,call.arguments.x])).toEqual([['mouseMoved',1],['mouseMoved',101],['mousePressed',101]]);
  await f.connection.close();
});

it('applies keyboard dismissal resizing after an in-flight viewport claim completes', async()=>{
  const f=fixture(); await f.connection.start();
  const bounds={x:0,y:0,width:929,height:329,deviceScaleFactor:2,focused:false,visible:true,dim:0};
  f.connection.layout(bounds);
  const original=f.rpc.getMockImplementation()!;
  let finish!:()=>void;
  f.rpc.mockImplementation(async(method,args)=>{
    if(method==='browser.page.view.focus') await new Promise<void>(resolve=>{finish=resolve;});
    return original(method,args);
  });
  const claim=f.connection.activate();
  while(!finish) await Promise.resolve();
  f.connection.layout({...bounds,focused:true,height:751});
  finish(); await claim;
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(f.rpc).toHaveBeenCalledWith('browser.page.view.resize',expect.objectContaining({height:751,focusEpoch:1}));
  await f.connection.close();
});

it('discards a context response after the pane loses focus',async()=>{
  const f=fixture();await f.connection.start();
  const bounds={x:0,y:0,width:800,height:600,focused:true,visible:true,dim:0};
  f.connection.layout(bounds);f.frame(800,600);await f.connection.activate();
  const original=f.rpc.getMockImplementation()!;
  let finish!:(value:any)=>void;
  f.rpc.mockImplementation(async(method,args)=>method==='browser.page.view.context'?await new Promise(resolve=>{finish=resolve;}):original(method,args));
  const result=f.connection.context(12.9,25.3);
  while(!finish)await Promise.resolve();
  expect(f.rpc).toHaveBeenLastCalledWith('browser.page.view.context',expect.objectContaining({x:12,y:25}));
  f.connection.layout({...bounds,focused:false});
  finish({text:'selection',canCopy:true,canCut:false,canPaste:false,canSelectAll:true});
  expect(await result).toBeUndefined();await f.connection.close();
});

it('clipboard state waits for a delayed focus claim and cancels on actual focus loss',async()=>{
  const f=fixture();await f.connection.start();
  const bounds={x:0,y:0,width:800,height:600,focused:true,visible:true,dim:0};
  f.connection.layout(bounds);f.frame(800,600);await f.connection.activate();
  const original=f.rpc.getMockImplementation()!;
  let release!:()=>void;
  f.rpc.mockImplementation(async(method,args)=>{
    if(method==='browser.page.view.focus')await new Promise<void>(resolve=>{release=resolve;});
    if(method==='browser.page.view.interaction')return {cursor:0,text:'copied',inputMode:1};
    return original(method,args);
  });
  const focus=f.connection.activate();while(!release)await Promise.resolve();
  expect(await f.connection.interaction()).toBeUndefined();
  const state=f.connection.interaction(true);
  await new Promise(resolve=>setTimeout(resolve,50));
  expect(f.rpc.mock.calls.some(([method])=>method==='browser.page.view.interaction')).toBe(false);
  release();await focus;expect(await state).toEqual({cursor:0,text:'copied',inputMode:1});
  release=undefined!;const next=f.connection.activate();while(!release)await Promise.resolve();
  const cancelled=f.connection.interaction(true);f.connection.layout({...bounds,focused:false});
  release();await next;expect(await cancelled).toBeUndefined();await f.connection.close();
});
