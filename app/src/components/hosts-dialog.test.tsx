import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AppActions, AppController, PairedHost } from '@/app/app-controller';
import { HostsDialog } from './hosts-dialog';

const controller = (hosts: PairedHost[]): AppController => ({
  model: { hosts, sessions: [], agents: {}, unread: new Set() },
  actions: { forgetHost: vi.fn(), reconnectHost: vi.fn(), pairHost: vi.fn() } as unknown as AppActions,
});

describe('HostsDialog', () => {
  it('says a revoked device has to pair again, and fills in the Host to pair with', async () => {
    const user = userEvent.setup();
    const hosts = controller([{
      id: 'h', name: 'mac.example.ts.net', url: 'wss://mac.example.ts.net:7341', status: 'revoked',
      error: 'This device was revoked on the Host, and has forgotten the pairing. Pair it again to see its sessions.',
    }]);
    render(<HostsDialog controller={hosts} open onOpenChange={() => {}} />);
    expect(screen.getByText('Revoked')).toBeInTheDocument();
    expect(screen.getByText(/Pair it again to see its sessions/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect to mac.example.ts.net' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Pair again' }));
    expect(screen.getByLabelText('URL')).toHaveValue('https://mac.example.ts.net:7341');
    expect(screen.getByLabelText('Code')).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Remove mac.example.ts.net' }));
    expect(hosts.actions.forgetHost).toHaveBeenCalledWith('h');
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
