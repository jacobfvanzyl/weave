import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { type MockScenario, useMockController } from '@/app/use-mock-controller';
import { AppShell } from './app-shell';

function MockApp({ scenario = 'list', bannerMs, turnMs }: { scenario?: MockScenario; bannerMs?: number; turnMs?: number }) {
  return <AppShell controller={useMockController(scenario, { bannerMs, turnMs })} />;
}

const setIdiom = (idiom?: 'phone' | 'pad') => {
  if (idiom) document.documentElement.dataset.deviceIdiom = idiom;
  else delete document.documentElement.dataset.deviceIdiom;
};

afterEach(() => setIdiom());

describe('the session list', () => {
  it('puts waiting sessions under Needs you and groups the rest by Host and directory', () => {
    setIdiom('phone');
    render(<MockApp />);
    const needsYou = screen.getByRole('group', { name: 'Needs you' });
    expect(within(needsYou).getByText('Fix the flaky reconnect test')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'tui on mac.tail1234.ts.net' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'odin on build.tail1234.ts.net' })).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'Waiting for you' }).length).toBeGreaterThan(0);
  });

  it('closes or deletes a session from its row, without opening it', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    const row = () => screen.queryByRole('button', { name: /^Steer handling in the TUI/ });
    await user.pointer({ keys: '[MouseRight]', target: row()! });
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Close session' }));
    expect(row()).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Steer handling in the TUI' })).not.toBeInTheDocument();

    // Closed, it offers only Delete, confirmed.
    await user.click(screen.getByRole('button', { name: 'Show closed' }));
    await user.pointer({ keys: '[MouseRight]', target: row()! });
    const closedMenu = await screen.findByRole('menu');
    expect(within(closedMenu).queryByRole('menuitem', { name: 'Close session' })).not.toBeInTheDocument();
    await user.click(within(closedMenu).getByRole('menuitem', { name: 'Delete session…' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete Steer handling in the TUI?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(row()).not.toBeInTheDocument());
  });

  it('hides closed sessions until asked', async () => {
    setIdiom('phone');
    const user = userEvent.setup();
    render(<MockApp />);
    expect(screen.queryByText('Pencil hover')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show closed' }));
    expect(screen.getByText('Pencil hover')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide closed' }));
    expect(screen.queryByText('Pencil hover')).not.toBeInTheDocument();
  });

  it('filters sessions', async () => {
    setIdiom('phone');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.type(screen.getByRole('searchbox', { name: 'Filter sessions' }), 'odin');
    expect(screen.getByText('Diagnose upload failures')).toBeInTheDocument();
    expect(screen.queryByText('Bring Alpha back')).not.toBeInTheDocument();
  });

  it('offers pairing when no Host is paired', () => {
    setIdiom('phone');
    render(<MockApp scenario='empty' />);
    expect(screen.getByText('No Hosts yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pair a Host' })).toBeInTheDocument();
  });

  it('starts a session in a directory from its heading', async () => {
    setIdiom('phone');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.click(screen.getByRole('button', { name: 'New session in odin' }));
    const form = screen.getByRole('form', { name: 'New session' });
    expect(within(form).getByLabelText('Directory')).toHaveValue('/srv/odin');
    await user.selectOptions(within(form).getByLabelText('Agent'), 'Codex');
    await user.click(within(form).getByRole('button', { name: 'Start' }));
    const session = await screen.findByRole('region', { name: 'New session' });
    expect(within(session).getByText('Codex')).toBeInTheDocument();
  });
});

describe('on an iPhone', () => {
  it('stacks the session over the list, with Back counting the other waiting sessions', async () => {
    setIdiom('phone');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.click(screen.getByText('Bring Alpha back'));
    expect(screen.queryByRole('group', { name: 'Needs you' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Bring Alpha back' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message agent' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sessions, 1 waiting' }));
    expect(screen.getByRole('group', { name: 'Needs you' })).toBeInTheDocument();
  });

  it('says how many other clients are attached', async () => {
    setIdiom('phone');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.click(screen.getByText('Bring Alpha back'));
    expect(screen.getByLabelText('1 other client attached')).toBeInTheDocument();
  });
});

describe('on an iPad', () => {
  it('shows the list beside one session', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    expect(screen.getByText('No session open')).toBeInTheDocument();
    await user.click(screen.getByText('Diagnose upload failures'));
    expect(screen.getByRole('region', { name: 'Diagnose upload failures' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Needs you' })).toBeInTheDocument();
  });
});

describe('a session that starts waiting off screen', () => {
  it('raises a banner that opens it', async () => {
    setIdiom('phone');
    const user = userEvent.setup();
    render(<MockApp scenario='banner' bannerMs={20} />);
    const banner = await screen.findByRole('status');
    expect(within(banner).getByText('Bring Alpha back needs you')).toBeInTheDocument();
    expect(within(banner).getByText('Permission to edit app/src/App.tsx')).toBeInTheDocument();
    await user.click(within(banner).getByText('Bring Alpha back needs you'));
    expect(screen.getByRole('region', { name: 'Bring Alpha back' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Bring Alpha back needs you')).not.toBeInTheDocument());
  });

  it('raises none for sessions already waiting when the app opens', async () => {
    setIdiom('phone');
    render(<MockApp />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(screen.queryByText(/needs you$/)).not.toBeInTheDocument();
  });
});

describe('the composer in a running session', () => {
  it('queues for an agent that cannot take steers, and sends the queue when the turn ends', async () => {
    setIdiom('phone');
    const user = userEvent.setup();
    render(<MockApp scenario='running' turnMs={50} />);
    const queued = screen.getByRole('list', { name: 'Queued messages' });
    expect(within(queued).getByText('Then regenerate the fixtures.')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Message agent' }), 'And the docs');
    await user.click(screen.getByRole('button', { name: 'Queue message' }));
    expect(within(screen.getByRole('list', { name: 'Queued messages' })).getByText('And the docs')).toBeInTheDocument();
  });
});
