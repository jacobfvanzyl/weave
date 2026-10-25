import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  it('puts waiting sessions under Needs you and groups the rest by Host and directory, or by worktree', () => {
    setIdiom('phone');
    render(<MockApp />);
    const needsYou = screen.getByRole('group', { name: 'Needs you' });
    expect(within(needsYou).getByText('Fix the flaky reconnect test')).toBeInTheDocument();
    // Sessions in a repository group under it by worktree, saying where in it they run.
    const weave = screen.getByRole('group', { name: 'weave on mac.tail1234.ts.net' });
    const main = within(weave).getByRole('group', { name: 'weave main' });
    expect(within(main).getByRole('button', { name: /^Steer handling in the TUI.*· tui/ })).toBeInTheDocument();
    expect(within(weave).getByRole('group', { name: 'weave fix-reconnect' })).toBeInTheDocument();
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
    await user.click(within(menu).getByRole('menuitem', { name: 'Close thread' }));
    expect(row()).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Steer handling in the TUI' })).not.toBeInTheDocument();

    // Closed, it offers only Delete, confirmed.
    await user.click(screen.getByRole('button', { name: 'Show closed' }));
    await user.pointer({ keys: '[MouseRight]', target: row()! });
    const closedMenu = await screen.findByRole('menu');
    expect(within(closedMenu).queryByRole('menuitem', { name: 'Close thread' })).not.toBeInTheDocument();
    await user.click(within(closedMenu).getByRole('menuitem', { name: 'Delete thread…' }));
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
    await user.type(screen.getByRole('searchbox', { name: 'Filter threads' }), 'odin');
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
    await user.click(screen.getByRole('button', { name: 'New thread in odin' }));
    const form = screen.getByRole('form', { name: 'New thread' });
    expect(within(form).getByRole('button', { name: 'Directory' })).toHaveAttribute('title', '/srv/odin');
    await user.selectOptions(within(form).getByLabelText('Agent'), 'Codex');
    await user.click(within(form).getByRole('button', { name: 'Start' }));
    const session = await screen.findByRole('region', { name: 'New thread' });
    expect(within(session).getByText('Codex')).toBeInTheDocument();
  });
});

describe('worktrees', () => {
  it('starts a session in a new worktree from a repository\u2019s heading, and removes the worktree', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.click(screen.getByRole('button', { name: 'New thread in weave main' }));
    const form = screen.getByRole('form', { name: 'New thread' });
    await user.click(await within(form).findByRole('button', { name: 'Worktree' }));
    const listed = within(screen.getByRole('list', { name: 'Worktrees' })).getAllByRole('button');
    expect(listed.map(({ textContent }) => textContent)).toEqual([
      'mainweave · 6 threads',
      'fix-reconnectweave.fix-reconnect · changed · 1 thread',
    ]);
    await user.type(screen.getByRole('textbox', { name: 'Branch' }), 'feature/auth');
    await user.click(screen.getByRole('button', { name: 'Create worktree' }));
    expect(await within(form).findByRole('button', { name: 'Worktree' })).toHaveTextContent('feature/authweave.feature-auth');
    await user.click(within(form).getByRole('button', { name: 'Start' }));
    await screen.findByRole('region', { name: 'New thread' });
    const group = within(screen.getByRole('group', { name: 'weave on mac.tail1234.ts.net' })).getByRole('group', { name: 'weave feature/auth' });

    await user.pointer({ keys: '[MouseRight]', target: within(group).getByText('feature/auth') });
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Remove worktree…' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Remove weave.feature-auth?' });
    expect(confirm).toHaveTextContent('feature/auth is deleted too if it\u2019s merged');
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'weave feature/auth' })).not.toBeInTheDocument());
  });

  it('keeps a worktree while one of its sessions waits on the person, and the primary one always', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    const group = screen.getByRole('group', { name: 'weave fix-reconnect' });
    await user.pointer({ keys: '[MouseRight]', target: within(group).getByText('fix-reconnect') });
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Remove worktree…' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Remove weave.fix-reconnect?' });
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent('waiting on you');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));

    // The repository's own checkout offers no removal.
    const main = screen.getByRole('group', { name: 'weave main' });
    await user.pointer({ keys: '[MouseRight]', target: within(main).getByText('main') });
    expect(screen.queryByRole('menuitem', { name: 'Remove worktree…' })).not.toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: 'Threads, 1 waiting' }));
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

describe('Hosts', () => {
  it('renames a Host on this device, and the list says the new name', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.click(screen.getByRole('button', { name: 'Hosts' }));
    const hosts = await screen.findByRole('dialog', { name: 'Hosts' });
    await user.click(within(hosts).getByRole('button', { name: 'Rename mac.tail1234.ts.net' }));
    const rename = await screen.findByRole('dialog', { name: 'Rename Host' });
    const name = within(rename).getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Studio Mac{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename Host' })).not.toBeInTheDocument());
    expect(within(hosts).getByText('Studio Mac')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Hosts' })).not.toBeInTheDocument());
    expect(screen.getByRole('group', { name: 'weave on Studio Mac' })).toBeInTheDocument();
  });
});

describe('on an iPad', () => {
  it('shows the list beside one session', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    expect(screen.getByText('No thread open')).toBeInTheDocument();
    await user.click(screen.getByText('Diagnose upload failures'));
    expect(screen.getByRole('region', { name: 'Diagnose upload failures' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Needs you' })).toBeInTheDocument();
  });

  it('drags the list\'s edge, or moves it with the arrow keys, and keeps the width', async () => {
    setIdiom('pad');
    localStorage.clear();
    const user = userEvent.setup();
    const { unmount } = render(<MockApp />);
    const edge = () => screen.getByRole('separator', { name: 'Resize threads' });
    expect(edge()).toHaveAttribute('aria-valuenow', '256');

    // The list ends where the pointer is.
    fireEvent.pointerDown(edge(), { clientX: 256 });
    fireEvent.pointerMove(edge(), { clientX: 320 });
    fireEvent.pointerUp(edge(), { clientX: 320 });
    expect(edge()).toHaveAttribute('aria-valuenow', '320');
    fireEvent.pointerMove(edge(), { clientX: 400 });
    expect(edge()).toHaveAttribute('aria-valuenow', '320');
    // No narrower than 14rem, and no wider than half the window (1024 pixels) or 30rem.
    fireEvent.pointerDown(edge(), { clientX: 320 });
    fireEvent.pointerMove(edge(), { clientX: 100 });
    expect(edge()).toHaveAttribute('aria-valuenow', '224');
    fireEvent.pointerMove(edge(), { clientX: 900 });
    expect(edge()).toHaveAttribute('aria-valuenow', '480');
    fireEvent.pointerUp(edge());

    edge().focus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(edge()).toHaveAttribute('aria-valuenow', '448');

    unmount();
    render(<MockApp />);
    expect(edge()).toHaveAttribute('aria-valuenow', '448');
    await user.dblClick(edge());
    expect(edge()).toHaveAttribute('aria-valuenow', '256');
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
