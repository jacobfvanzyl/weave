import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ClientBrowserSidebarTile } from './client-browser-sidebar-tile';
import { SidebarProvider } from './ui/sidebar';

const metadata = vi.hoisted(() => vi.fn());
vi.mock('@/client-browser/native-client-browser', () => ({ clientBrowserAvailable: true }));
vi.mock('@/client-browser/workspace-client-browser', () => ({ workspaceClientBrowser: { metadata } }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
const props = { hostId: 'host', paneId: 'pane', initialUrl: 'https://initial.test/', active: true, select: vi.fn() };
const mount = () => render(<SidebarProvider><ClientBrowserSidebarTile {...props} /></SidebarProvider>);
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); };

it('follows local titles and favicon updates while the page is hidden and keeps pane selection', async () => {
  vi.useFakeTimers();
  metadata.mockResolvedValue({ title: 'First site', url: 'https://local.test/first', faviconUrl: 'https://local.test/first.svg', hidden: true });
  mount(); await tick();
  let row = screen.getByRole('button', { name: 'Client Browser First site' });
  expect(row.querySelector('img')).toHaveAttribute('src', 'https://local.test/first.svg');
  expect(row.querySelector('[data-agent-browser-badge]')).toBeNull();
  expect(row).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(row); expect(props.select).toHaveBeenCalled();
  expect(metadata).toHaveBeenCalledWith('host', 'pane');
  metadata.mockResolvedValue({ title: 'Second site', url: 'https://local.test/second', faviconUrl: 'https://local.test/second.svg', hidden: true });
  await tick(); row = screen.getByRole('button', { name: 'Client Browser Second site' });
  expect(row.querySelector('img')).toHaveAttribute('src', 'https://local.test/second.svg');
  metadata.mockRejectedValue(new Error('Temporary bridge failure'));
  await tick(); expect(row).toHaveTextContent('Second site');
});

it('uses the hostname or New page and a browser glyph for unavailable or failed icons', async () => {
  vi.useFakeTimers(); metadata.mockResolvedValue(undefined);
  mount(); await tick();
  expect(screen.getByRole('button', { name: 'Client Browser initial.test' }).querySelector('img')).toBeNull();
  metadata.mockResolvedValue({ title: '', url: 'https://local.test/path', faviconUrl: 'https://local.test/missing.ico' });
  await tick();
  const row = screen.getByRole('button', { name: 'Client Browser local.test' });
  fireEvent.error(row.querySelector('img')!); expect(row.querySelector('img')).toBeNull();
  metadata.mockResolvedValue({ title: '', url: 'about:blank', faviconUrl: 'file:///private/icon.png' });
  await tick();
  expect(screen.getByRole('button', { name: 'Client Browser New page' }).querySelector('img')).toBeNull();
});
