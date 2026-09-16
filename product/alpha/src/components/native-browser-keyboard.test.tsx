import {act,fireEvent,render,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({interaction:vi.fn(),input:vi.fn(),hide:()=>{},keyboard:vi.fn(async({requestId}:{requestId:string})=>{const input=document.querySelector<HTMLElement>(`[data-keyboard-request="${requestId}"]`)!;input.focus();delete input.dataset.keyboardRefocusing;})}));
vi.mock('@capacitor/core',async original=>{const actual=await original<typeof import('@capacitor/core')>();return {...actual,Capacitor:{...actual.Capacitor,getPlatform:()=> 'ios'}};});
vi.mock('@capacitor/keyboard',()=>({Keyboard:{addListener:vi.fn((_name,fn)=>{mocks.hide=fn;return Promise.resolve({remove:vi.fn()});})}}));
vi.mock('@/terminal/native-terminal',()=>({nativeSoftwareKeyboard:true,nativeTerminalAvailable:false,nativeTerminalBridge:{focusWeb:vi.fn(async()=>{})}}));
vi.mock('@/browser/native-browser',()=>({nativeBrowserBridge:{keyboard:mocks.keyboard}}));
vi.mock('@/browser/browser-view-connection',()=>({BrowserViewConnection:class{
 layout=vi.fn();start=vi.fn();close=vi.fn();activate=vi.fn();ensureActive=vi.fn();input=mocks.input;interaction=mocks.interaction;
}}));
import {NativeBrowserView} from './native-browser-view';
import {PaneFocusProvider,PaneFocusScope} from '@/app/pane-focus';
const page={pageId:crypto.randomUUID(),profileId:crypto.randomUUID(),generation:crypto.randomUUID(),url:'https://example.test',title:'Fixture',available:true};
beforeEach(()=>{
 vi.clearAllMocks();mocks.interaction.mockResolvedValue({cursor:0,text:'',inputMode:1});
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({x:0,y:0,width:800,height:600} as DOMRect);
});
function tap(input:HTMLElement,pointerType='touch'){for(const type of ['pointerdown','pointerup']){const event=new MouseEvent(type,{bubbles:true,clientX:30,clientY:40});Object.defineProperty(event,'pointerType',{value:pointerType});fireEvent(input,event);}}
it.each(['touch','pen','mouse'])('requires an editable target and deliberate %s input; dismissal and pane refocus keep the keyboard closed',async(pointerType)=>{
 const {getByRole}=render(<PaneFocusProvider><PaneFocusScope id='browser'><NativeBrowserView client={{} as any} page={page} focused /></PaneFocusScope></PaneFocusProvider>);
 const input=getByRole('textbox') as HTMLTextAreaElement;
 const blur=vi.fn();document.addEventListener('focusout',blur);
 act(()=>input.focus());expect(input.readOnly).toBe(true);expect(mocks.keyboard).not.toHaveBeenCalled();
 tap(input,pointerType);await waitFor(()=>expect(mocks.interaction).toHaveBeenCalled());expect(input.readOnly).toBe(true);
 mocks.interaction.mockResolvedValue({cursor:3,text:'',inputMode:0});tap(input,pointerType);
 await waitFor(()=>expect(input.readOnly).toBe(false));expect(mocks.keyboard).toHaveBeenCalled();expect(blur).not.toHaveBeenCalled();
 act(()=>mocks.hide());expect(input.readOnly).toBe(true);
 await new Promise(resolve=>setTimeout(resolve,200));expect(input.readOnly).toBe(true);
 fireEvent.keyDown(input,{key:'A'});expect(mocks.input).toHaveBeenCalledWith('Input.insertText',{text:'A'});
 tap(input,pointerType);await waitFor(()=>expect(input.readOnly).toBe(false));
 act(()=>{input.blur();input.focus();});expect(input.readOnly).toBe(true);
 await new Promise(resolve=>setTimeout(resolve,200));expect(input.readOnly).toBe(true);document.removeEventListener('focusout',blur);
});
