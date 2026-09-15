import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { it, expect, vi } from 'vitest';
import type { AlphaController } from '@/app/alpha-controller';
import { BrowserGrantsDialog } from './browser-grants-dialog';
it('does not save grants until requested and preserves the grant revision on revocation', async () => {
  const request = vi.fn(async (method: string) => method === 'browser.profile.list' ? { profiles: [{ profileId: 'profile', name: 'Work', revision: 0 }] } : { threadId: 'thread', profileIds: ['profile'], revision: 4 });
  const client = { browserRequest: request }, close = vi.fn();
  const controller = { browserClient: () => client } as unknown as AlphaController;
  render(<BrowserGrantsDialog controller={controller} hostId='host' threadId='thread' open onOpenChange={close} />);
  const checkbox = await screen.findByRole('checkbox', { name: 'Work' });
  expect(checkbox).toBeChecked(); expect(request).toHaveBeenCalledTimes(2);
  await userEvent.click(checkbox); expect(request).toHaveBeenCalledTimes(2);
  await userEvent.click(screen.getByRole('button', { name: 'Save access' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('browser.grants.set', { threadId: 'thread', profileIds: [], expectedRevision: 4 }));
  expect(close).toHaveBeenCalledWith(false);
});
