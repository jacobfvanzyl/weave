import { useEffect, useRef, useState } from 'react';
import type { BrowserPage } from '@weave/product-protocol';
import type { DirectHostClient } from '@/portal-client';
import { BrowserViewConnection } from '@/browser/browser-view-connection';
import { paneOverlayOpen, paneVisible, usePaneFocusAdapter } from '@/app/pane-focus';
import { nativeTerminalBridge } from '@/terminal/native-terminal';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
const modifiers = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
export function NativeBrowserView({ client, page, focused }: { client: Pick<DirectHostClient, 'browserRequest' | 'browserDisplay'>; page: BrowserPage; focused: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null), connection = useRef<BrowserViewConnection | undefined>(undefined);
  const latest = useRef(focused); latest.current = focused;
  const { owner, id } = usePaneFocusAdapter();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const measure = useRef<() => void>(() => {}), composing = useRef(false), lastKey = useRef({key:'',at:0}), touch = useRef<{x:number;y:number;startX:number;startY:number;dragged:boolean} | undefined>(undefined);
  useEffect(() => { measure.current(); }, [focused]);
  useEffect(() => {
    const element = input.current!; let stopped = false, frame = 0; setError(undefined);
    const current = new BrowserViewConnection(client, page, event => { if (stopped) return; if (event.error) setError(event.error); else { setError(undefined); element.dataset.frameWidth = String(event.width); element.dataset.frameHeight = String(event.height); owner?.ready(); } });
    connection.current = current;
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0; if (stopped) return;
        const rect = element.getBoundingClientRect();
        current.layout({ x:rect.x, y:rect.y, width:rect.width, height:rect.height, focused:latest.current, visible:!document.hidden && paneVisible(element) && !paneOverlayOpen(), dim:latest.current ? 0 : 0.4 });
      });
    };
    measure.current = update;
    const resize = new ResizeObserver(update); resize.observe(element);
    const mutations = new MutationObserver(update); mutations.observe(document.body, { subtree:true, attributes:true, childList:true, attributeFilter:['style','class','hidden','inert','aria-hidden','data-focused'] });
    document.addEventListener('visibilitychange', update); window.addEventListener('resize', update);
    const unregister = id && owner?.register(id, { element, available:() => page.available && paneVisible(element), focus:async isCurrent => { await nativeTerminalBridge.focusWeb(); if (!isCurrent()) return false; element.focus({ preventScroll:true }); return document.activeElement === element; } });
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
    element.addEventListener('beforeinput',beforeInput);
    void current.start(); update();
    return () => { stopped = true; element.removeEventListener('beforeinput',beforeInput); cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect(); unregister && unregister(); window.removeEventListener('resize',update); document.removeEventListener('visibilitychange',update); void current.close(); };
  }, [client, page.pageId, page.generation, owner, id, attempt]);
  const point = (event: { clientX: number; clientY: number }) => { const rect = input.current!.getBoundingClientRect(); return { x:event.clientX-rect.x, y:event.clientY-rect.y }; };
  const key = (event: React.KeyboardEvent<HTMLTextAreaElement>, type: string) => {
    if (event.nativeEvent.isComposing || composing.current) return;
    if (type === 'rawKeyDown') lastKey.current = {key:event.key,at:Date.now()};
    const special = event.key.length > 1 || event.ctrlKey || event.metaKey;
    if (special && !((event.ctrlKey || event.metaKey) && /^[cvx]$/i.test(event.key))) event.preventDefault();
    void connection.current?.input('Input.dispatchKeyEvent', { type, key:event.key, code:event.code, windowsVirtualKeyCode:event.keyCode, modifiers:modifiers(event), autoRepeat:event.repeat });
  };
  return <div className='relative flex min-h-0 min-w-0 flex-1 flex-col'>
    {error && <Alert variant='destructive'><AlertDescription>{error}<Button variant="outline" size="sm" onClick={() => setAttempt(value => value + 1)}>Reconnect display</Button></AlertDescription></Alert>}
    <textarea ref={input} aria-label='Browser page input' data-slot='native-browser-input' onPointerCancel={() => { touch.current=undefined; }} style={{touchAction:'none'}} className='min-h-0 min-w-0 flex-1 resize-none border-0 bg-transparent p-0 text-transparent caret-transparent outline-none' autoCapitalize='none' autoCorrect='off' spellCheck={false}
      onFocus={() => { if (id) owner?.didFocus(id); void connection.current?.activate(); }}
      onBlur={() => { if (id) owner?.didBlur(id); }}
      onPointerDown={event => { if (event.pointerType === 'touch') { touch.current = {x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,dragged:false}; void connection.current?.activate(); return; } if (event.isTrusted) input.current?.setPointerCapture(event.pointerId); void connection.current?.activate(); void connection.current?.input('Input.dispatchMouseEvent', { type:'mousePressed', ...point(event), button:event.button === 2 ? 'right' : 'left', buttons:event.buttons, clickCount:1, modifiers:modifiers(event) }); }}
      onPointerUp={event => { if (event.pointerType === 'touch') { const value=touch.current; touch.current=undefined; if(value && !value.dragged) { for(const type of ['mousePressed','mouseReleased']) void connection.current?.input('Input.dispatchMouseEvent',{type,...point(event),button:'left',clickCount:1}); } return; } void connection.current?.input('Input.dispatchMouseEvent', { type:'mouseReleased', ...point(event), button:event.button === 2 ? 'right' : 'left', buttons:event.buttons, clickCount:1, modifiers:modifiers(event) }); }}
      onPointerMove={event => { const value=touch.current; if(event.pointerType === 'touch' && value) { event.preventDefault(); if(Math.hypot(event.clientX-value.startX,event.clientY-value.startY)>6) value.dragged=true; if(value.dragged) void connection.current?.input('Input.dispatchMouseEvent',{type:'mouseWheel',...point(event),deltaX:value.x-event.clientX,deltaY:value.y-event.clientY}); value.x=event.clientX;value.y=event.clientY;return; } if (event.buttons) void connection.current?.input('Input.dispatchMouseEvent', { type:'mouseMoved', ...point(event), button:'left', buttons:event.buttons, modifiers:modifiers(event) }); }}
      onContextMenu={event => event.preventDefault()}
      onWheel={event => { void connection.current?.input('Input.dispatchMouseEvent', { type:'mouseWheel', ...point(event), deltaX:event.deltaX, deltaY:event.deltaY, modifiers:modifiers(event) }); }}
      onKeyDown={event => key(event,'rawKeyDown')} onKeyUp={event => key(event,'keyUp')}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={event => { composing.current = false; if (event.data) void connection.current?.input('Input.insertText', { text:event.data }); event.currentTarget.value = ''; }}

      onChange={event => { if (!composing.current) event.currentTarget.value = ''; }}
      onPaste={event => { event.preventDefault(); const text = event.clipboardData.getData('text/plain'); if (text) void connection.current?.input('Input.insertText', { text }); }} />
  </div>;
}
