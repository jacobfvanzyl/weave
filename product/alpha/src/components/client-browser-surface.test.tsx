import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ClientBrowserSurface } from './client-browser-surface';

const native = vi.hoisted(() => ({
  command: vi.fn().mockResolvedValue(undefined), layout: vi.fn().mockResolvedValue(undefined),
  focus: vi.fn().mockResolvedValue(undefined), snapshot: vi.fn(),
  addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
}));
vi.mock('@/client-browser/native-client-browser', () => ({ clientBrowserAvailable: true, nativeClientBrowser: native }));
vi.mock('@/client-browser/workspace-client-browser', () => ({ workspaceClientBrowser: { attach: vi.fn().mockResolvedValue({ surfaceId: 'local-page' }), detach: vi.fn().mockResolvedValue(undefined) } }));
afterEach(() => vi.clearAllMocks());
const reference = { hostId: 'host', workspaceId: 'workspace' };
const node = { kind: 'client-browser', nodeId: 'pane', paneId: 'pane', initialUrl: 'about:blank' } as const;
const page = { pageIdentity: 'web-page', url: 'about:blank', title: '', canGoBack: false, canGoForward: false, loading: false, error: '' };
function mount() {
  native.snapshot.mockResolvedValue(page);
  const controller = { model: { connections: [{ hostId: 'host', status: 'connected' }] }, actions: {}, browserClient: vi.fn(), workspaceActions: { focus: vi.fn() } } as any;
  render(<ClientBrowserSurface controller={controller} reference={reference} node={node} focused maximized={false} />);
  return controller;
}

it('keeps typed addresses through native snapshots and sends navigation only to the local page', async () => {
  const user = userEvent.setup();
  const controller = mount();
  const address = screen.getByRole<HTMLInputElement>('textbox', { name: 'Client Browser address' });
  await waitFor(() => expect(address).toHaveFocus());
  await user.type(address, 'localhost:4199');
  await waitFor(() => expect(native.snapshot).toHaveBeenCalled());
  expect(address).toHaveValue('localhost:4199');
  await user.keyboard('{Enter}');
  await waitFor(() => expect(native.command).toHaveBeenCalledWith({ surfaceId: 'local-page', action: 'navigate', address: 'https://localhost:4199' }));
  expect(controller.browserClient).not.toHaveBeenCalled();
});

it('follows native history availability and routes chrome shortcuts and page Cmd-L to the shared address field', async () => {
  const user = userEvent.setup();
  mount();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Reload' })).toBeEnabled());
  expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
  native.snapshot.mockResolvedValue({ ...page, url: 'https://example.test/', canGoBack: true, canGoForward: true });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Back' }));
  await user.click(screen.getByRole('button', { name: 'Forward' }));
  await user.click(screen.getByRole('button', { name: 'Reload' }));
  for (const action of ['back', 'forward', 'reload']) expect(native.command).toHaveBeenCalledWith({ surfaceId: 'local-page', action });
  const pane = screen.getByRole('region', { name: 'Client Browser pane' });
  fireEvent.keyDown(pane, { key: 'r', metaKey: true });
  fireEvent.keyDown(pane, { key: 'ArrowLeft', altKey: true });
  fireEvent.keyDown(pane, { key: 'l', metaKey: true });
  const address = screen.getByRole<HTMLInputElement>('textbox', { name: 'Client Browser address' });
  expect(address).toHaveFocus();
  address.blur();
  act(() => native.addListener.mock.calls[0]![1]({ surfaceId: 'another-page', kind: 'focus-address' }));
  expect(address).not.toHaveFocus();
  act(() => native.addListener.mock.calls[0]![1]({ surfaceId: 'local-page', kind: 'focus-address' }));
  expect(address).toHaveFocus();
  expect(address.selectionStart).toBe(0);
  expect(address.selectionEnd).toBe('https://example.test/'.length);
});

it('shows native navigation errors in the pane while retaining its chrome', async () => {
  mount();
  native.snapshot.mockResolvedValue({ ...page, error: 'The server could not be found.' });
  await screen.findByText('The server could not be found.');
  expect(screen.getByRole('textbox', { name: 'Client Browser address' })).toBeVisible();
});
