import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { BrowserSurface } from './browser-surface';
const profileId='11111111-1111-4111-8111-111111111111',pageId='22222222-2222-4222-8222-222222222222';
it('opens blank with the URL field focused and preserves typing when Host state arrives',async()=>{
  const user=userEvent.setup();
  let complete!: (value:any)=>void;
  const pagePromise=new Promise(resolve=>{complete=resolve;});
  const request=vi.fn(async(method:string)=>method==='browser.profile.list'?{profiles:[]}:pagePromise);
  const controller={browserClient:()=>({browserRequest:request}),model:{},actions:{},workspaceActions:{focus:vi.fn()}} as any;
  render(<BrowserSurface controller={controller} reference={{hostId:'host',workspaceId:'workspace'}} node={{kind:'browser',nodeId:pageId,paneId:pageId,profileId,lastCommittedUrl:'about:blank'}} focused maximized={false} />);
  const address=screen.getByRole('textbox',{name:'Browser address'});
  expect(address).toHaveFocus(); expect(address).toHaveValue('');
  await user.type(address,'localhost:4199');
  complete({page:{pageId,profileId,title:'',url:'about:blank',available:true,temporary:true,generation:pageId}});
  await waitFor(()=>expect(screen.getByRole('button',{name:'Reload'})).toBeEnabled());
  expect(address).toHaveValue('localhost:4199'); expect(address).toHaveFocus();
  await user.keyboard('{Enter}');
  await waitFor(()=>expect(request).toHaveBeenCalledWith('browser.page.navigate',expect.objectContaining({url:'https://localhost:4199'})));
});

it('routes address and navigation shortcuts at the Browser Pane boundary', async()=>{
  const {fireEvent}=await import('@testing-library/react');
  const page={pageId,profileId,title:'Page',url:'https://example.test/',available:true,generation:pageId};
  const request=vi.fn(async()=>({page}));
  const controller={browserClient:()=>({browserRequest:request}),model:{},actions:{},workspaceActions:{focus:vi.fn()}} as any;
  render(<BrowserSurface controller={controller} reference={{hostId:'host',workspaceId:'workspace'}} node={{kind:'browser',nodeId:pageId,paneId:pageId,profileId,lastCommittedUrl:page.url}} focused maximized={false} />);
  await waitFor(()=>expect(screen.getByRole('button',{name:'Reload'})).toBeEnabled());
  const pane=screen.getByRole('region',{name:'Browser pane'});
  fireEvent.keyDown(pane,{key:'l',metaKey:true});
  expect(screen.getByRole('textbox',{name:'Browser address'})).toHaveFocus();
  fireEvent.keyDown(pane,{key:'r',metaKey:true});
  await waitFor(()=>expect(request).toHaveBeenCalledWith('browser.page.reload',expect.objectContaining({pageId})));
  fireEvent.keyDown(pane,{key:'ArrowLeft',altKey:true});
  await waitFor(()=>expect(request).toHaveBeenCalledWith('browser.page.back',expect.objectContaining({pageId})));
});
