import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeBrowserView } from './native-browser-view';
const connection = vi.hoisted(() => ({ layout:vi.fn(), start:vi.fn(), close:vi.fn(), activate:vi.fn(), input:vi.fn(), interaction:vi.fn(), context:vi.fn(), clipboard:vi.fn() }));
vi.mock('@/browser/browser-view-connection', () => ({ BrowserViewConnection:class {
  layout = connection.layout; start = connection.start; close = connection.close;
  activate = connection.activate; ensureActive = connection.activate; input = connection.input; interaction = connection.interaction; context=connection.context; clipboard = connection.clipboard;
} }));
const page = { pageId:crypto.randomUUID(), profileId:crypto.randomUUID(), generation:crypto.randomUUID(), title:'Page', url:'https://example.test', available:true };
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x:0, y:0, width:800, height:600 } as DOMRect);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback:FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('keeps live pixels under menus and modal isolation, but hides a workspace that is no longer rendered', async () => {
  const client = {} as any;
  const content = (overlay = false, hidden = false) => <>
    <section hidden={hidden} aria-hidden={overlay || undefined} inert={overlay || undefined}>
      <NativeBrowserView client={client} page={page} focused />
    </section>
    {overlay && <div role='dialog'><input aria-label='Dialog input' /></div>}
  </>;
  const { rerender, getByRole, unmount } = render(content());
  await waitFor(() => expect(connection.layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible:true, inputBlocked:false })));
  expect(getByRole('textbox')).toHaveAttribute('data-native-layered', 'true');
  rerender(content(true));
  await waitFor(() => expect(connection.layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible:true, inputBlocked:true, focused:true })));
  act(() => getByRole('textbox', { name:'Dialog input' }).focus());
  expect(getByRole('textbox', { name:'Dialog input' })).toHaveFocus();
  expect(connection.close).not.toHaveBeenCalled();
  rerender(content());
  await waitFor(() => expect(connection.layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible:true, inputBlocked:false })));
  rerender(content(false, true));
  await waitFor(() => expect(connection.layout).toHaveBeenLastCalledWith(expect.objectContaining({ visible:false, inputBlocked:true })));
  expect(connection.start).toHaveBeenCalledOnce();
  unmount(); expect(connection.close).toHaveBeenCalledOnce();
});

it('sends hover, middle buttons and repeated click counts; keeps clipboard shortcuts local', async()=>{
  const {getByRole}=render(<NativeBrowserView client={{} as any} page={page} focused />);
  const input=getByRole('textbox',{name:'Browser page input'});
  const pointer=(type:string,buttons:number,button=0)=>{
    const event=new MouseEvent(type,{bubbles:true,clientX:30,clientY:40,buttons,button});
    Object.defineProperty(event,'pointerType',{value:'mouse'});fireEvent(input,event);
  };
  pointer('pointermove',0);pointer('pointerdown',1);pointer('pointerup',0);pointer('pointerdown',1);pointer('pointerup',0);
  expect(connection.input).toHaveBeenCalledWith('Input.dispatchMouseEvent',expect.objectContaining({type:'mouseMoved',buttons:0}));
  expect(connection.input).toHaveBeenLastCalledWith('Input.dispatchMouseEvent',expect.objectContaining({type:'mouseReleased',clickCount:2}));
  pointer('pointerdown',4,1);
  expect(connection.input).toHaveBeenLastCalledWith('Input.dispatchMouseEvent',expect.objectContaining({button:'middle',clickCount:1}));
  connection.input.mockClear();fireEvent.keyDown(input,{key:'c',metaKey:true});
  expect(connection.input).not.toHaveBeenCalled();
});

it('copies only after an explicit action and does not cut a selection that changed during clipboard write', async()=>{
  connection.interaction.mockResolvedValueOnce({cursor:3,text:'alpha'}).mockResolvedValueOnce({cursor:3,text:'changed'});
  connection.clipboard.mockResolvedValue({});
  const {getByRole}=render(<NativeBrowserView client={{} as any} page={page} focused />);
  expect(connection.clipboard).not.toHaveBeenCalled();
  fireEvent.cut(getByRole('textbox',{name:'Browser page input'}));
  await waitFor(()=>expect(connection.clipboard).toHaveBeenCalledWith('alpha'));
  await waitFor(()=>expect(connection.interaction).toHaveBeenCalledTimes(2));
  expect(connection.input).not.toHaveBeenCalledWith('Input.dispatchKeyEvent',expect.objectContaining({commands:['DeleteBackward']}));
});

it('offers only the CEF context actions, not a universal edit menu', async()=>{
  connection.context.mockResolvedValue({text:'read only selection',canCopy:true,canCut:false,canPaste:false,canSelectAll:true});
  const {getByRole,queryByRole}=render(<NativeBrowserView client={{} as any} page={page} focused />);
  fireEvent.contextMenu(getByRole('textbox',{name:'Browser page input'}),{clientX:30,clientY:40});
  await waitFor(()=>expect(getByRole('menuitem',{name:'Copy'})).toBeVisible());
  expect(queryByRole('menuitem',{name:'Cut'})).not.toBeInTheDocument();
  expect(queryByRole('menuitem',{name:'Paste'})).not.toBeInTheDocument();
  expect(connection.clipboard).not.toHaveBeenCalled();
});
