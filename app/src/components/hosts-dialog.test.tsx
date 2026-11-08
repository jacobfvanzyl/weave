import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AppActions, AppController, DispatcherSummary, HostSummary } from '@/app/app-controller';
import { HostsDialog } from './hosts-dialog';

const DISPATCHER: DispatcherSummary = { id: 'd', name: 'homelab', url: 'wss://homelab.example.ts.net:7342', status: 'connected' };

const controller = (hosts: HostSummary[], dispatcher: DispatcherSummary | undefined = DISPATCHER): AppController => ({
  model: { dispatcher, hosts, threads: [], agents: {}, unread: new Set() },
  actions: { forgetDispatcher: vi.fn(), reconnectDispatcher: vi.fn(), reconnectHost: vi.fn(), pairDispatcher: vi.fn() } as unknown as AppActions,
});

describe('HostsDialog', () => {
  it('lists the Hosts the Dispatcher reaches, and why it can\'t reach one', () => {
    const app = controller([
      { id: 'h1', name: 'mac', status: 'connected' },
      { id: 'h2', name: 'studio', status: 'unreachable', error: "It hasn't connected to the Dispatcher since the Dispatcher started." },
    ]);
    render(<HostsDialog controller={app} open onOpenChange={() => {}} />);
    expect(screen.getByRole('region', { name: 'Dispatcher' })).toHaveTextContent('Dispatcher on homelab');
    expect(screen.getByRole('region', { name: 'Dispatcher' })).toHaveTextContent('Connected');
    const hosts = screen.getByRole('list', { name: 'Hosts' });
    expect(hosts).toHaveTextContent('mac');
    expect(hosts).toHaveTextContent('Unreachable');
    expect(hosts).toHaveTextContent("It hasn't connected to the Dispatcher since the Dispatcher started.");
    // Paired: pairing again is a step away, not in the way.
    expect(screen.queryByRole('form', { name: 'Pair with the Dispatcher' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pair again' })).toBeInTheDocument();
  });

  it('says the Dispatcher can\'t be reached, and tries again when asked', async () => {
    const user = userEvent.setup();
    const app = controller([{ id: 'h1', name: 'mac', status: 'reconnecting' }], {
      ...DISPATCHER, status: 'reconnecting', error: "Couldn't reach the Dispatcher: connection refused",
    });
    render(<HostsDialog controller={app} open onOpenChange={() => {}} />);
    expect(screen.getByText('Unreachable')).toBeInTheDocument();
    expect(screen.getByText(/connection refused/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reconnect to the Dispatcher' }));
    expect(app.actions.reconnectDispatcher).toHaveBeenCalled();
  });

  it('offers to pair again when the Dispatcher refused the device', async () => {
    const user = userEvent.setup();
    const app = controller([], { ...DISPATCHER, status: 'refused', error: "The Dispatcher refused this device (this device couldn't be authenticated). Pair it again." });
    render(<HostsDialog controller={app} open onOpenChange={() => {}} />);
    expect(screen.getByText('Refused')).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Pair with the Dispatcher' });
    expect(form).toBeInTheDocument();
    await user.type(screen.getByLabelText('URL'), 'wss://homelab.example.ts.net:7342');
    await user.type(screen.getByLabelText('Code'), 'ABCD');
    await user.click(screen.getByRole('button', { name: 'Pair' }));
    expect(app.actions.pairDispatcher).toHaveBeenCalledWith({ url: 'wss://homelab.example.ts.net:7342', code: 'ABCD', name: 'Browser' });
  });

  it('asks to confirm a pairing link, by its address', () => {
    const app = controller([{ id: 'h1', name: 'mac', status: 'connected' }]);
    render(<HostsDialog controller={app} open onOpenChange={() => {}} offer={{ url: 'wss://homelab.example.ts.net:7342', code: 'ABCD' }} />);
    expect(screen.getByText('homelab.example.ts.net')).toBeInTheDocument();
    expect(screen.getByLabelText('URL')).toHaveValue('wss://homelab.example.ts.net:7342');
    expect(screen.getByLabelText('Code')).toHaveValue('ABCD');
  });

  it('forgets the Dispatcher, once confirmed', async () => {
    const user = userEvent.setup();
    const app = controller([{ id: 'h1', name: 'mac', status: 'connected' }]);
    render(<HostsDialog controller={app} open onOpenChange={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Forget the Dispatcher' }));
    await user.click(await screen.findByRole('button', { name: 'Forget Dispatcher' }));
    expect(app.actions.forgetDispatcher).toHaveBeenCalled();
  });

  it('offers to reconnect to a Host that speaks another protocol, once one of them is updated', async () => {
    const user = userEvent.setup();
    const app = controller([{
      id: 'h', name: 'mac', status: 'incompatible',
      error: 'This Host needs a newer version of the app: it speaks protocol versions 3 to 4; this app speaks version 2.',
    }]);
    render(<HostsDialog controller={app} open onOpenChange={() => {}} />);
    expect(screen.getByText('Incompatible')).toBeInTheDocument();
    expect(screen.getByText(/speaks protocol versions 3 to 4/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reconnect to mac' }));
    expect(app.actions.reconnectHost).toHaveBeenCalledWith('h');
  });
});
