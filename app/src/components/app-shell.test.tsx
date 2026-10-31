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
  it('groups sessions by Host, then directory or repository, naming each one\u2019s agent and branch', () => {
    setIdiom('phone');
    render(<MockApp />);
    const mac = screen.getByRole('group', { name: 'mac.tail1234.ts.net' });
    const weave = within(mac).getByRole('group', { name: 'weave' });
    // A repository's threads list together, across its worktrees, with the branch after the agent.
    expect(within(weave).getByRole('button', { name: /Fix the flaky reconnect test.*Claude\s*· fix-reconnect/ })).toBeInTheDocument();
    expect(within(weave).getByRole('button', { name: /^Steer handling in the TUI.*Claude\s*· main \/ tui/ })).toBeInTheDocument();
    const build = screen.getByRole('group', { name: 'build.tail1234.ts.net' });
    expect(within(build).getByRole('group', { name: 'odin' })).toBeInTheDocument();
    // Waiting threads stay in place, marked on their tile.
    expect(within(weave).getByRole('img', { name: 'Waiting for you' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Needs you' })).not.toBeInTheDocument();
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
  it('starts a session in a new worktree from a repository\u2019s heading, and removes the worktree from its thread', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.click(screen.getByRole('button', { name: 'New thread in weave' }));
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
    const weave = within(screen.getByRole('group', { name: 'mac.tail1234.ts.net' })).getByRole('group', { name: 'weave' });
    const row = within(weave).getByRole('button', { name: /^New thread.*· feature\/auth/ });

    await user.pointer({ keys: '[MouseRight]', target: row });
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Remove worktree…' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Remove weave.feature-auth?' });
    expect(confirm).toHaveTextContent('feature/auth is deleted too if it\u2019s merged');
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /· feature\/auth/ })).not.toBeInTheDocument());
  });

  it('keeps a worktree while one of its sessions waits on the person, and the primary one always', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('button', { name: /Fix the flaky reconnect test/ }) });
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Remove worktree…' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Remove weave.fix-reconnect?' });
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    expect(await within(confirm).findByRole('alert')).toHaveTextContent('waiting on you');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));

    // A thread in the repository's own checkout offers no removal.
    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('button', { name: /^Steer handling in the TUI/ }) });
    expect(await screen.findByRole('menuitem', { name: 'Close thread' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Remove worktree…' })).not.toBeInTheDocument();
  });
});

describe('on an iPhone', () => {
  it('stacks the session over the list, with Back counting the other waiting sessions', async () => {
    setIdiom('phone');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.click(screen.getByText('Bring Alpha back'));
    expect(screen.queryByRole('group', { name: 'mac.tail1234.ts.net' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Bring Alpha back' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message agent' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Threads, 1 waiting' }));
    expect(screen.getByRole('group', { name: 'mac.tail1234.ts.net' })).toBeInTheDocument();
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
    expect(within(screen.getByRole('group', { name: 'Studio Mac' })).getByRole('group', { name: 'weave' })).toBeInTheDocument();
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
    expect(screen.getByRole('group', { name: 'mac.tail1234.ts.net' })).toBeInTheDocument();
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
