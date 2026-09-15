import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeBrowserView } from './native-browser-view';
const connection = vi.hoisted(() => ({ layout:vi.fn(), start:vi.fn(), close:vi.fn(), activate:vi.fn(), input:vi.fn() }));
vi.mock('@/browser/browser-view-connection', () => ({ BrowserViewConnection:class {
  layout = connection.layout; start = connection.start; close = connection.close;
  activate = connection.activate; input = connection.input;
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
