import { Capacitor } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { browserFramebufferSize, browserViewportScale, type BrowserPage, type BrowserContext } from '@weave/product-protocol';
import type { DirectHostClient } from '@/portal-client';
import { BrowserViewConnection } from '@/browser/browser-view-connection';
import { nativeBrowserBridge } from '@/browser/native-browser';
import { wheelPixels } from '@/browser/browser-wheel';
import { paneOverlayOpen, paneRendered, paneVisible, usePaneFocusAdapter } from '@/app/pane-focus';
import { nativeTerminalBridge } from '@/terminal/native-terminal';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuGroup, ContextMenuItem } from './ui/context-menu';
const iosKeyboard = Capacitor.getPlatform()==='ios';
const inputModes = ['text','none','text','tel','url','email','numeric','decimal','search'] as const;
const cursors = ['default','crosshair','pointer','text','wait','help','e-resize','n-resize','ne-resize','nw-resize','s-resize','se-resize','sw-resize','w-resize','ns-resize','ew-resize','nesw-resize','nwse-resize','col-resize','row-resize','all-scroll','e-resize','n-resize','ne-resize','nw-resize','s-resize','se-resize','sw-resize','w-resize','move','vertical-text','cell','context-menu','alias','progress','no-drop','copy','none','not-allowed','zoom-in','zoom-out','grab','grabbing','ns-resize','ew-resize','default','no-drop','move','copy','alias'];
const modifiers = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
export function NativeBrowserView({ client, page, focused, addressInput }: { client: Pick<DirectHostClient, 'browserRequest' | 'browserDisplay'>; page: BrowserPage; focused: boolean; addressInput?: RefObject<HTMLInputElement | null> }) {
  const clicks = useRef({ x:0, y:0, at:0, button:-1, count:0 });
  const hovering = useRef(false);
  const [cursor, setCursor] = useState('default');
  const [keyboardMode,setKeyboardMode]=useState(1);
  const keyboardAllowed=useRef(false), remoteInputMode=useRef(1);
  const [menu,setMenu]=useState<BrowserContext>();
  const [menuOpen,setMenuOpen]=useState(false);
  const menuRequest=useRef(0), menuPoint=useRef({x:0,y:0});
  const input = useRef<HTMLTextAreaElement>(null), connection = useRef<BrowserViewConnection | undefined>(undefined);
  const preferredAddress = useRef(addressInput); preferredAddress.current=addressInput;
  const latest = useRef(focused); latest.current = focused;
  const { owner, id } = usePaneFocusAdapter();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const measure = useRef<() => void>(() => {}), composing = useRef(false), lastKey = useRef({key:'',at:0}), touch = useRef<{x:number;y:number;startX:number;startY:number;dragged:boolean} | undefined>(undefined);
  useEffect(() => { measure.current(); if(!focused){keyboardAllowed.current=false;setKeyboardMode(1);setMenuOpen(false);menuRequest.current++;} }, [focused]);
  useEffect(()=>{
    const element=input.current;
    if(!iosKeyboard || keyboardMode===1 || !element || document.activeElement!==element)return;
    // The Host reply is asynchronous, so WebKit needs an embedding-client
    // focus request to show its keyboard. Scope that request to this input.
    const requestId=crypto.randomUUID();element.dataset.keyboardRequest=requestId;
    // Finish the readonly focus session before the native request starts a
    // new editable session; WebKit coalesces blur/focus within one script.
    element.dataset.keyboardRefocusing='true';element.blur();
    void nativeBrowserBridge.keyboard?.({requestId}).catch(cause=>setError(String(cause)));
    return()=>{delete element.dataset.keyboardRequest;delete element.dataset.keyboardRefocusing;};
  },[keyboardMode]);
  useEffect(()=>{
    if(!iosKeyboard)return;
    const listener=Keyboard.addListener('keyboardDidHide',()=>{if(document.activeElement===input.current && !input.current?.readOnly && input.current?.dataset.keyboardRefocusing!=='true'){keyboardAllowed.current=false;setKeyboardMode(1);}});
    return()=>{void listener.then(handle=>handle.remove());};
  },[]);
  useEffect(() => {
    const element = input.current!; let stopped = false, frame = 0; setError(undefined);
    const current = new BrowserViewConnection(client, page, event => { if (stopped) return; if (event.error) setError(event.error); else { setError(undefined); element.dataset.diagnosticId = event.diagnosticId ?? ''; element.dataset.frameWidth = String(event.width); element.dataset.frameHeight = String(event.height); owner?.ready(); } });
    connection.current = current;
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0; if (stopped) return;
        const rect = element.getBoundingClientRect();
        const deviceScaleFactor = browserViewportScale(Math.floor(rect.width), Math.floor(rect.height), window.devicePixelRatio || 1);
        const pixels = browserFramebufferSize({ width:Math.floor(rect.width), height:Math.floor(rect.height), deviceScaleFactor });
        element.dataset.expectedFrameWidth = String(pixels.width); element.dataset.expectedFrameHeight = String(pixels.height);
        current.layout({ deviceScaleFactor, x:rect.x, y:rect.y, width:Math.floor(rect.width), height:Math.floor(rect.height), focused:latest.current, visible:!document.hidden && paneRendered(element), inputBlocked:paneOverlayOpen() || !paneVisible(element), dim:latest.current ? 0 : 0.4 });
      });
    };
    let density = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const densityChanged = () => { density.removeEventListener('change', densityChanged); density = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`); density.addEventListener('change', densityChanged); update(); };
    density.addEventListener('change', densityChanged);
    measure.current = update;
    const resize = new ResizeObserver(update); resize.observe(element);
    const mutations = new MutationObserver(update); mutations.observe(document.body, { subtree:true, attributes:true, childList:true, attributeFilter:['style','class','hidden','inert','aria-hidden','data-focused'] });
    document.addEventListener('visibilitychange', update); window.addEventListener('resize', update);
    const unregister = id && owner?.register(id, { element, available:() => page.available && paneVisible(element), focus:async isCurrent => { await nativeTerminalBridge.focusWeb(); if (!isCurrent()) return false; const target=preferredAddress.current?.current ?? element; target.focus({ preventScroll:true }); return document.activeElement === target; } });
    const beforeInput = (event: InputEvent) => {
      if (composing.current || event.isComposing || event.inputType === 'insertFromComposition') return;
      event.preventDefault();
      if (event.data) void current.input('Input.insertText', {text:event.data});
      else {
        const key = event.inputType === 'deleteContentBackward' ? 'Backspace' : event.inputType === 'deleteContentForward' ? 'Delete' : ['insertLineBreak','insertParagraph'].includes(event.inputType) ? 'Enter' : undefined;
        if (key && !(lastKey.current.key === key && Date.now()-lastKey.current.at < 100)) {
          const windowsVirtualKeyCode = key === 'Backspace' ? 8 : key === 'Delete' ? 46 : 13;
          void current.input('Input.dispatchKeyEvent',{type:'rawKeyDown',key,windowsVirtualKeyCode});
          void current.input('Input.dispatchKeyEvent',{type:'keyUp',key,windowsVirtualKeyCode});
        }
      }
      element.value = '';
    };
    // CEF owns selection/cursor state; querying only a hovered, focused view
    // also picks up cursor changes caused by script without pointer movement.
    let reading = false;
    const interaction = setInterval(() => {
      if (reading || !latest.current || (!hovering.current && !(iosKeyboard && document.activeElement===element)) || document.hidden) return;
      reading = true;
      void current.interaction().then(state => { if (!stopped && state) { setCursor(cursors[state.cursor] ?? 'default'); remoteInputMode.current=state.inputMode; if(iosKeyboard)setKeyboardMode(keyboardAllowed.current ? state.inputMode : 1); } }).catch(() => {}).finally(() => { reading = false; });
    }, 150);
    element.addEventListener('beforeinput',beforeInput);
    void current.start(); update();
    return () => { stopped = true; menuRequest.current++; keyboardAllowed.current=false; clearInterval(interaction); density.removeEventListener('change', densityChanged); element.removeEventListener('beforeinput',beforeInput); cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect(); unregister && unregister(); window.removeEventListener('resize',update); document.removeEventListener('visibilitychange',update); void current.close(); };
  }, [client, page.pageId, page.generation, owner, id, attempt]);
  const point = (event: { clientX: number; clientY: number }) => { const rect = input.current!.getBoundingClientRect(); return { x:event.clientX-rect.x, y:event.clientY-rect.y }; };
  const key = (event: React.KeyboardEvent<HTMLTextAreaElement>, type: string) => {
    if (event.nativeEvent.isComposing || composing.current) return;
    if (type === 'rawKeyDown') lastKey.current = {key:event.key,at:Date.now()};
    if ((event.ctrlKey || event.metaKey) && /^[cvx]$/i.test(event.key)) return;
    // A hidden software keyboard must not disable a connected hardware one.
    if(iosKeyboard && input.current?.readOnly && remoteInputMode.current!==1 && type==='rawKeyDown' && event.key.length===1 && !event.ctrlKey && !event.metaKey){
      event.preventDefault();void connection.current?.input('Input.insertText',{text:event.key});
    }
    const special = event.key.length > 1 || event.ctrlKey || event.metaKey;
    if (special && !((event.ctrlKey || event.metaKey) && /^[cvx]$/i.test(event.key))) event.preventDefault();
    void connection.current?.input('Input.dispatchKeyEvent', { type, key:event.key, code:event.code, windowsVirtualKeyCode:event.keyCode, modifiers:modifiers(event), autoRepeat:event.repeat, ...((event.metaKey || event.ctrlKey) && type==='rawKeyDown' && /^[azy]$/i.test(event.key) ? {commands:[event.key.toLowerCase()==='a'?'SelectAll':event.key.toLowerCase()==='y'||event.shiftKey?'Redo':'Undo']} : {}) });
  };
  const copySelection = async (cut: boolean) => {
    try {
      const current = connection.current, state = await current?.interaction(true);
      if (!state?.text) return;
      await current?.clipboard(state.text);
      // Recheck after the asynchronous clipboard write. This catches changed
      // text; shared browser input is not a transaction over selection identity.
      if (cut && (await current?.interaction(true))?.text === state.text)
        await current?.input('Input.dispatchKeyEvent', { type:'rawKeyDown', key:'Backspace', windowsVirtualKeyCode:8, commands:['DeleteBackward'] });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const menuAction = (action: () => Promise<unknown>) => {
    // Let the menu release modal isolation before sending page input.
    requestAnimationFrame(() => requestAnimationFrame(() => { void action().catch(cause => setError(String(cause))); }));
  };
  return <ContextMenu open={menuOpen} onOpenChange={(open,details) => {
    if(!open){menuRequest.current++;setMenuOpen(false);return;}
    details.cancel();touch.current=undefined;
    const request=++menuRequest.current;
    void connection.current?.context(menuPoint.current.x,menuPoint.current.y).then(state=>{
      if(request!==menuRequest.current || !latest.current || !state)return;
      setMenu(state);setMenuOpen(state.canCopy || state.canCut || state.canPaste || state.canSelectAll);
    }).catch(cause=>setError(String(cause)));
  }}><div className='relative flex min-h-0 min-w-0 flex-1 flex-col'>
    {error && <Alert variant='destructive'><AlertDescription>{error}<Button variant="outline" size="sm" onClick={() => setAttempt(value => value + 1)}>Reconnect display</Button></AlertDescription></Alert>}
    <ContextMenuTrigger className='flex min-h-0 min-w-0 flex-1'><textarea ref={input} readOnly={iosKeyboard && keyboardMode===1} inputMode={iosKeyboard ? inputModes[keyboardMode] : 'text'} aria-label='Browser page input' data-slot='native-browser-input' data-native-layered={error ? undefined : 'true'} onPointerCancel={event => { touch.current=undefined; if (event.pointerType !== 'touch') void connection.current?.input('Input.dispatchMouseEvent',{type:'mouseReleased',...point(event),buttons:0,button:clicks.current.button===2?'right':clicks.current.button===1?'middle':'left',clickCount:clicks.current.count}); }} style={{touchAction:'none', cursor}} className='min-h-0 min-w-0 flex-1 resize-none border-0 bg-transparent p-0 text-transparent caret-transparent outline-none' autoCapitalize='none' autoCorrect='off' spellCheck={false}
      onFocus={() => { if (id) owner?.didFocus(id); void connection.current?.activate(); }}
      onBlur={event => { if(input.current?.dataset.keyboardRefocusing==='true'){event.stopPropagation();return;}keyboardAllowed.current=false;setKeyboardMode(1);if (id) owner?.didBlur(id); }}
      onPointerDown={event => { menuPoint.current=point(event); if (event.pointerType === 'touch') { const now=performance.now(), previous=clicks.current; clicks.current={x:event.clientX,y:event.clientY,at:now,button:0,count:previous.button===0 && now-previous.at<500 && Math.hypot(event.clientX-previous.x,event.clientY-previous.y)<12 ? previous.count%3+1 : 1}; touch.current = {x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,dragged:false}; void connection.current?.ensureActive(); return; } if (event.isTrusted) input.current?.setPointerCapture(event.pointerId);
        const previous=clicks.current, now=performance.now();
        clicks.current={ x:event.clientX, y:event.clientY, at:now, button:event.button, count:previous.button===event.button && now-previous.at<500 && Math.hypot(event.clientX-previous.x,event.clientY-previous.y)<5 ? previous.count%3+1 : 1 }; void connection.current?.ensureActive(); if(event.button!==2) void connection.current?.input('Input.dispatchMouseEvent', { type:'mousePressed', ...point(event), button:event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left', buttons:event.buttons, clickCount:clicks.current.count, modifiers:modifiers(event) }); }}
      onPointerUp={event => { if (event.pointerType === 'touch') { const value=touch.current; touch.current=undefined; if(value && !value.dragged) { keyboardAllowed.current=true; for(const type of ['mousePressed','mouseReleased']) void connection.current?.input('Input.dispatchMouseEvent',{type,...point(event),button:'left',buttons:type==='mousePressed'?1:0,clickCount:clicks.current.count}); } return; } if(iosKeyboard && event.button===0)keyboardAllowed.current=true; if(event.button!==2) void connection.current?.input('Input.dispatchMouseEvent', { type:'mouseReleased', ...point(event), button:event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left', buttons:event.buttons, clickCount:clicks.current.count, modifiers:modifiers(event) }); }}
      onPointerMove={event => { const value=touch.current; if(event.pointerType === 'touch' && value) { event.preventDefault(); if(Math.hypot(event.clientX-value.startX,event.clientY-value.startY)>6) value.dragged=true; if(value.dragged) void connection.current?.input('Input.dispatchMouseEvent',{type:'mouseWheel',...point(event),deltaX:value.x-event.clientX,deltaY:value.y-event.clientY}); value.x=event.clientX;value.y=event.clientY;return; } if (event.pointerType !== 'touch') void connection.current?.input('Input.dispatchMouseEvent', { type:'mouseMoved', ...point(event), button:event.buttons & 1 ? 'left' : event.buttons & 2 ? 'right' : event.buttons & 4 ? 'middle' : 'none', buttons:event.buttons, modifiers:modifiers(event) }); }}
      onPointerEnter={event => { hovering.current=event.pointerType !== 'touch'; }}
      onPointerLeave={event => { hovering.current=false; if (!event.buttons && event.pointerType !== 'touch') void connection.current?.input('Input.dispatchMouseEvent',{type:'mouseMoved',...point(event),mouseLeave:true,buttons:0}); }}
      onWheel={event => { const element = event.currentTarget; const lineHeight = event.deltaMode === 1 ? parseFloat(getComputedStyle(element).lineHeight) || 16 : 16; void connection.current?.input('Input.dispatchMouseEvent', { type:'mouseWheel', ...point(event), ...wheelPixels(event, lineHeight, element.clientHeight, element.clientWidth), modifiers:modifiers(event) }); }}
      onKeyDown={event => key(event,'rawKeyDown')} onKeyUp={event => key(event,'keyUp')}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={event => { composing.current = false; if (event.data) void connection.current?.input('Input.insertText', { text:event.data }); event.currentTarget.value = ''; }}

      onChange={event => { if (!composing.current) event.currentTarget.value = ''; }}
      onCopy={event => { event.preventDefault(); void copySelection(false); }}
      onCut={event => { event.preventDefault(); void copySelection(true); }}
      onPaste={event => { event.preventDefault(); const text = event.clipboardData.getData('text/plain'); if (text) void connection.current?.input('Input.insertText', { text }); }} /></ContextMenuTrigger>
  </div><ContextMenuContent><ContextMenuGroup>
    {menu?.canCopy && <ContextMenuItem onClick={() => menuAction(() => copySelection(false))}>Copy</ContextMenuItem>}
    {menu?.canCut && <ContextMenuItem onClick={() => menuAction(() => copySelection(true))}>Cut</ContextMenuItem>}
    {menu?.canPaste && <ContextMenuItem onClick={() => menuAction(async () => { const result=await connection.current?.clipboard(); if (result?.text) await connection.current?.input('Input.insertText',{text:result.text}); })}>Paste</ContextMenuItem>}
    {menu?.canSelectAll && <ContextMenuItem onClick={() => menuAction(async () => { await connection.current?.input('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'a',commands:['SelectAll']}); })}>Select All</ContextMenuItem>}
  </ContextMenuGroup></ContextMenuContent></ContextMenu>;
}
