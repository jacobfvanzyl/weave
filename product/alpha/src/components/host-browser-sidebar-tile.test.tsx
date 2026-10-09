import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { HostBrowserSidebarTile } from './host-browser-sidebar-tile';
import { SidebarProvider } from './ui/sidebar';

afterEach(() => vi.useRealTimers());
it('updates Agent Browser site metadata and keeps its badge when a favicon fails', async () => {
  vi.useFakeTimers();
  const browserRequest = vi.fn().mockResolvedValue({ page: { title: 'First site', url: 'https://site.test/first', faviconUrl: 'https://site.test/first.svg' } });
  const client = { browserRequest }, controller = { browserClient: vi.fn(() => client) } as any, select = vi.fn();
  render(<SidebarProvider><HostBrowserSidebarTile controller={controller} hostId='host' paneId='pane' profileId='profile' active select={select} /></SidebarProvider>);
  const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); };
  await tick();
  let row = screen.getByRole('button', { name: 'Agent Browser First site' });
  expect(row.querySelector('img')).toHaveAttribute('src', 'https://site.test/first.svg');
  expect(row.querySelector('[data-agent-browser-badge]')).toHaveAttribute('title', 'Agent Browser');
  expect(row).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(row); expect(select).toHaveBeenCalledOnce();
  expect(browserRequest).toHaveBeenCalledWith('browser.page.get', { profileId: 'profile', pageId: 'pane' });
  browserRequest.mockResolvedValue({ page: { title: '', url: 'https://other.test/path', faviconUrl: 'https://other.test/missing.ico' } });
  await tick(); row = screen.getByRole('button', { name: 'Agent Browser other.test' });
  fireEvent.error(row.querySelector('img')!);
  expect(row.querySelector('img')).toBeNull();
  expect(row.querySelector('[data-agent-browser-badge]')).toBeInTheDocument();
  browserRequest.mockResolvedValue({ page: { title: '', url: 'about:blank' } });
  await tick(); expect(screen.getByRole('button', { name: 'Agent Browser New page' })).toBeInTheDocument();
});
