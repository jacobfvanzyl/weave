import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { PaneSplitMenu } from './pane-split-menu';

it.each(['terminal', 'agent', 'browser'] as const)('defaults to Down then the source %s type for Enter confirmation', async sourceType => {
  const user = userEvent.setup(), split = vi.fn();
  render(<PaneSplitMenu sourceType={sourceType} onSplit={split} />);
  await user.click(screen.getByRole('button', { name: 'Split pane' }));
  await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Down' })).toHaveFocus());
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Down', 'Right']);
  await user.keyboard('{Enter}');
  await waitFor(() => expect(screen.getByRole('menuitem', { name: sourceType === 'agent' ? 'Agent' : sourceType === 'browser' ? 'Browser' : 'Terminal' })).toHaveFocus());
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Terminal', 'Agent', 'Browser']);
  expect(screen.getByRole('menuitem', { name: 'Browser' })).not.toHaveAttribute('aria-disabled', 'true');
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
