import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AppActions, AppController, PairedHost } from '@/app/app-controller';
import { HostsDialog } from './hosts-dialog';

const controller = (hosts: PairedHost[]): AppController => ({
  model: { hosts, sessions: [], agents: {}, unread: new Set() },
  actions: { forgetHost: vi.fn(), renameHost: vi.fn(), reconnectHost: vi.fn(), pairHost: vi.fn() } as unknown as AppActions,
});

describe('HostsDialog', () => {
  it('says a revoked device has to pair again, and fills in the Host to pair with', async () => {
    const user = userEvent.setup();
    const hosts = controller([{
      id: 'h', name: 'mac.example.ts.net', url: 'wss://mac.example.ts.net:7341', status: 'revoked',
      error: 'This device was revoked on the Host, and has forgotten the pairing. Pair it again to see its threads.',
    }]);
    render(<HostsDialog controller={hosts} open onOpenChange={() => {}} />);
    expect(screen.getByText('Revoked')).toBeInTheDocument();
    expect(screen.getByText(/Pair it again to see its threads/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect to mac.example.ts.net' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Pair again' }));
    expect(screen.getByLabelText('URL')).toHaveValue('https://mac.example.ts.net:7341');
    expect(screen.getByLabelText('Code')).toHaveFocus();

    // A revoked pairing is gone once the app quits, so there's nothing to rename.
    expect(screen.queryByRole('button', { name: 'Rename mac.example.ts.net' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove mac.example.ts.net' }));
    expect(hosts.actions.forgetHost).toHaveBeenCalledWith('h');
  });

  it('renames a Host, starting from its name, and says why it couldn\'t', async () => {
    const user = userEvent.setup();
    const hosts = controller([{ id: 'h', name: 'mac.example.ts.net', url: 'wss://mac.example.ts.net:7341', status: 'disconnected' }]);
    vi.mocked(hosts.actions.renameHost).mockRejectedValueOnce(new Error('The preferences are full.'));
    render(<HostsDialog controller={hosts} open onOpenChange={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Rename mac.example.ts.net' }));
    const rename = await screen.findByRole('dialog', { name: 'Rename Host' });
    const name = within(rename).getByRole('textbox', { name: 'Name' });
    expect(name).toHaveValue('mac.example.ts.net');
    await user.clear(name);
    expect(within(rename).getByRole('button', { name: 'Rename' })).toBeDisabled();
    await user.type(name, 'Studio Mac');
    await user.click(within(rename).getByRole('button', { name: 'Rename' }));
    expect(await within(rename).findByText('The preferences are full.')).toBeInTheDocument();
    await user.click(within(rename).getByRole('button', { name: 'Rename' }));
    expect(hosts.actions.renameHost).toHaveBeenLastCalledWith('h', 'Studio Mac');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename Host' })).not.toBeInTheDocument());
  });

  it('offers to reconnect to a Host that speaks another protocol, once one of them is updated', async () => {
    const user = userEvent.setup();
    const hosts = controller([{
      id: 'h', name: 'mac.example.ts.net', url: 'wss://mac.example.ts.net:7341', status: 'incompatible',
      error: 'This Host needs a newer version of the app: it speaks protocol versions 3 to 4; this app speaks version 2.',
    }]);
    render(<HostsDialog controller={hosts} open onOpenChange={() => {}} />);
    expect(screen.getByText('Incompatible')).toBeInTheDocument();
    expect(screen.getByText(/speaks protocol versions 3 to 4/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reconnect to mac.example.ts.net' }));
    expect(hosts.actions.reconnectHost).toHaveBeenCalledWith('h');
  });
});
