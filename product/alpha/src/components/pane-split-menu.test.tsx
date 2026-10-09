import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { PaneSplitMenu } from './pane-split-menu';

const browser = vi.hoisted(() => ({ clientBrowserAvailable: false }));
vi.mock('@/client-browser/native-client-browser', () => browser);
afterEach(() => { browser.clientBrowserAvailable = false; });

it.each(['terminal', 'agent', 'host-browser'] as const)('defaults to Down then the source %s type for Enter confirmation', async sourceType => {
  const user = userEvent.setup(), split = vi.fn();
  render(<PaneSplitMenu sourceType={sourceType} onSplit={split} />);
  await user.click(screen.getByRole('button', { name: 'Split pane' }));
  await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Down' })).toHaveFocus());
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Down', 'Right']);
  await user.keyboard('{Enter}');
  await waitFor(() => expect(screen.getByRole('menuitem', { name: sourceType === 'agent' ? 'Agent' : sourceType === 'host-browser' ? 'Host Browser' : 'Terminal' })).toHaveFocus());
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Terminal', 'Agent', 'Host Browser']);
  expect(screen.getByRole('menuitem', { name: 'Host Browser' })).not.toHaveAttribute('aria-disabled', 'true');
  await user.keyboard('{Enter}');
  expect(split).toHaveBeenCalledExactlyOnceWith('vertical', sourceType);
});

it('allows Right and a different type, and Escape cancels without splitting', async () => {
  const user = userEvent.setup(), split = vi.fn();
  render(<PaneSplitMenu sourceType='agent' onSplit={split} />);
  await user.click(screen.getByRole('button', { name: 'Split pane' }));
  await user.click(screen.getByRole('menuitem', { name: 'Right' }));
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  expect(split).toHaveBeenCalledExactlyOnceWith('horizontal', 'terminal');
  await user.click(screen.getByRole('button', { name: 'Split pane' }));
  await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Down' })).toHaveFocus());
  await user.keyboard('{Escape}');
  expect(split).toHaveBeenCalledTimes(1);
});

it('offers Client Browser on supported clients and defaults a browser split to its own type', async () => {
  browser.clientBrowserAvailable = true;
  const user = userEvent.setup(), split = vi.fn();
  render(<PaneSplitMenu sourceType='client-browser' onSplit={split} />);
  await user.click(screen.getByRole('button', { name: 'Split pane' }));
  await user.click(screen.getByRole('menuitem', { name: 'Right' }));
  await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Client Browser' })).toHaveFocus());
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Terminal', 'Agent', 'Host Browser', 'Client Browser']);
  await user.keyboard('{Enter}');
  expect(split).toHaveBeenCalledExactlyOnceWith('horizontal', 'client-browser');
});
