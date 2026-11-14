import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppController, AppModel } from '@/app/app-controller';
import { saveLastSession } from '@/session/view';
import { commandOn, runCommand } from '@/app/commands';
import { requestOpenThread } from '@/app/open-thread';
import { MOCK_FAILS, type MockScenario, useMockController } from '@/app/use-mock-controller';
import { AppShell } from './app-shell';

function MockApp({ scenario = 'list', bannerMs, turnMs }: { scenario?: MockScenario; bannerMs?: number; turnMs?: number }) {
  return <AppShell controller={useMockController(scenario, { bannerMs, turnMs })} />;
}

const setIdiom = (idiom?: 'phone' | 'pad') => {
  if (idiom) document.documentElement.dataset.deviceIdiom = idiom;
  else delete document.documentElement.dataset.deviceIdiom;
};

// Each test starts with no Session this device last showed.
beforeEach(() => localStorage.clear());
afterEach(() => setIdiom());

/** A Session's tile in the list: its name, then where it is. */
const tile = (name: RegExp) => screen.getByRole('button', { name });
/** New Block, open: a menu (WVE-229). */
const newBlock = () => screen.findByRole('menu', { name: 'New Block' });
/**
 * New Block's submenu `under`, opened from the keyboard. jsdom has no layout, so the pointer
 * leaving a submenu's trigger for the submenu closes it: the tests open and pick with the keys.
 */
const submenu = async (user: ReturnType<typeof userEvent.setup>, under: string) => {
  const trigger = within(await newBlock()).getByRole('menuitem', { name: under });
  act(() => trigger.focus());
  await user.keyboard('{ArrowRight}');
  return screen.findByRole('menu', { name: under });
};
/** Picks what New Block's submenu `under` names. */
const pick = async (user: ReturnType<typeof userEvent.setup>, under: string, name: RegExp | string) => {
  const item = within(await submenu(user, under)).getByRole('menuitem', { name });
  act(() => item.focus());
  await user.keyboard('{Enter}');
};

describe('the list of Sessions', () => {
  it('puts a Project’s Sessions together with their Host and branch, and the rest under their Hosts, by name alone', () => {
    setIdiom('phone');
    render(<MockApp />);
    const weave = screen.getByRole('group', { name: 'weave' });
    // The repository's worktrees are a Session each, whichever directory in them a thread runs in.
    expect(within(weave).getByRole('button', { name: /weave.*mac · main/ })).toBeInTheDocument();
    const reconnect = within(weave).getByRole('button', { name: /weave.*mac · fix-reconnect/ });
    // A thread waiting on the person marks its Session's tile.
    expect(within(reconnect).getByRole('img', { name: 'Waiting for you' })).toBeInTheDocument();
    expect(reconnect).toHaveTextContent('1 waiting on you');
    // Every Host is under "Hosts" (WVE-231). Nothing of the Mac's is outside the Project, so its
    // heading has nothing to fold; the other Host's directory is in no Project, and its tile has its name alone.
    const hosts = screen.getByRole('heading', { name: 'Hosts' });
    const mac = screen.getByRole('group', { name: 'mac' });
    expect(hosts.compareDocumentPosition(mac) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(weave.compareDocumentPosition(hosts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(mac).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['New Session on mac']);
    const build = screen.getByRole('group', { name: 'build' });
    expect(within(build).getByRole('button', { name: /^build/, expanded: true })).toBeInTheDocument();
    expect(within(build).getByRole('button', { name: /^odin/ })).not.toHaveTextContent('/srv/odin');
    // Threads aren't listed: a Session's are inside it.
    expect(screen.queryByText('Bring Alpha back')).not.toBeInTheDocument();
    // Nor is a Session made up for a worktree whose thread closed before its Host kept any.
    expect(screen.queryByRole('button', { name: /old-spike/ })).not.toBeInTheDocument();
    expect(within(weave).getAllByRole('button', { name: /mac · / })).toHaveLength(2);
  });

  it('collapses a Project or a Host from its heading, remembers it, and says what it hides is doing', async () => {
    setIdiom('phone');
    const user = userEvent.setup();
    const { unmount } = render(<MockApp />);
    const weave = () => screen.getByRole('group', { name: 'weave' });
    await user.click(within(weave()).getByRole('button', { name: /^weave/, expanded: true }));
    expect(within(weave()).queryByRole('button', { name: /mac · / })).not.toBeInTheDocument();
    // A thread in it waits on the person: the heading says so while it hides it.
    const heading = within(weave()).getByRole('button', { name: /^weave/, expanded: false });
    expect(within(heading).getByRole('img', { name: 'Waiting for you' })).toBeInTheDocument();
    await user.click(within(screen.getByRole('group', { name: 'build' })).getByRole('button', { name: /^build/, expanded: true }));
    expect(screen.queryByRole('button', { name: /^odin/ })).not.toBeInTheDocument();
    // The filter looks inside what's collapsed, and leaves it collapsed after.
    await user.click(screen.getByRole('button', { name: 'Filter Sessions' }));
    await user.type(screen.getByRole('searchbox', { name: 'Filter Sessions' }), 'reconnect');
    expect(within(weave()).getAllByRole('button', { name: /mac · / })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Filter Sessions' }));
    expect(within(weave()).queryByRole('button', { name: /mac · / })).not.toBeInTheDocument();
    // The device keeps it.
    unmount();
    render(<MockApp />);
    expect(within(weave()).queryByRole('button', { name: /mac · / })).not.toBeInTheDocument();
    await user.click(within(weave()).getByRole('button', { name: /^weave/, expanded: false }));
    expect(within(weave()).getAllByRole('button', { name: /mac · / })).toHaveLength(2);
    expect(within(within(weave()).getByRole('button', { name: /^weave/, expanded: true })).queryByRole('img')).not.toBeInTheDocument();
  });

  it('switches to Threads, a tile for each tab with a thread under no Project or Host, and remembers the view', async () => {
    setIdiom('phone');
    const user = userEvent.setup();
    const { unmount } = render(<MockApp />);
    const view = screen.getByRole('tablist', { name: 'View' });
    expect(within(view).getByRole('tab', { name: 'Sessions' })).toHaveAttribute('aria-selected', 'true');
    await user.click(within(view).getByRole('tab', { name: 'Threads' }));
    expect(within(screen.getByRole('tablist', { name: 'View' })).getByRole('tab', { name: 'Threads' })).toHaveAttribute('aria-selected', 'true');
    // The Bots stay; the Projects and Hosts go.
    expect(screen.getByRole('group', { name: 'Bots' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'weave' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Hosts' })).not.toBeInTheDocument();
    const threads = screen.getByRole('group', { name: 'Threads' });
    expect(within(threads).getByRole('button', { name: /^Bring Alpha back.*weave · mac · main/ })).toBeInTheDocument();
    expect(within(threads).getByRole('button', { name: /weave · mac · fix-reconnect.*1 waiting on you/ })).toBeInTheDocument();
    // The filter is the view's too.
    await user.click(screen.getByRole('button', { name: 'Filter Sessions' }));
    await user.type(screen.getByRole('searchbox', { name: 'Filter Sessions' }), 'alpha');
    expect(within(screen.getByRole('group', { name: 'Threads' })).getAllByRole('button')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Filter Sessions' }));
    unmount();
    render(<MockApp />);
    expect(screen.getByRole('group', { name: 'Threads' })).toBeInTheDocument();
    // A tile opens its Session.
    await user.click(within(screen.getByRole('group', { name: 'Threads' })).getByRole('button', { name: /^Bring Alpha back/ }));
    expect(await screen.findByRole('region', { name: 'Session weave' })).toBeInTheDocument();
  });

  it('filters Sessions', async () => {
    setIdiom('phone');
    const user = userEvent.setup();
    render(<MockApp />);
    // The filter is closed until its button opens it, with the keyboard in it.
    const toggle = screen.getByRole('button', { name: 'Filter Sessions' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('searchbox', { name: 'Filter Sessions' })).not.toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('searchbox', { name: 'Filter Sessions' })).toHaveFocus();
    await user.type(screen.getByRole('searchbox', { name: 'Filter Sessions' }), 'odin');
    expect(tile(/^odin/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'weave' })).not.toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox', { name: 'Filter Sessions' }));
    await user.type(screen.getByRole('searchbox', { name: 'Filter Sessions' }), 'reconnect');
    expect(within(screen.getByRole('group', { name: 'weave' })).getAllByRole('button', { name: /mac · / })).toHaveLength(1);

    // Closing it shows everything again: nothing stays filtered out of sight.
    await user.click(toggle);
    expect(screen.queryByRole('searchbox', { name: 'Filter Sessions' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'weave' })).getAllByRole('button', { name: /mac · / })).toHaveLength(2);
    // Escape in it closes it too, and opened again it starts empty.
    await user.click(toggle);
    await user.type(screen.getByRole('searchbox', { name: 'Filter Sessions' }), 'odin{Escape}');
    expect(screen.queryByRole('searchbox', { name: 'Filter Sessions' })).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
    expect(screen.getByRole('group', { name: 'weave' })).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.getByRole('searchbox', { name: 'Filter Sessions' })).toHaveValue('');
  });

  it('keeps the toggle for the list in the list’s own rail while it shows, and in the Session’s while it’s hidden', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp scenario='session' />);
    const session = screen.getByRole('region', { name: 'Session weave' });
    const hide = screen.getByRole('button', { name: 'Hide Sessions' });
    expect(session).not.toContainElement(hide);
    expect(within(session).queryByRole('button', { name: /Sessions/ })).not.toBeInTheDocument();
    await user.click(hide);
    expect(screen.queryByRole('button', { name: 'Hide Sessions' })).not.toBeInTheDocument();
    await user.click(within(session).getByRole('button', { name: /^Show Sessions/ }));
    expect(screen.getByRole('button', { name: 'Hide Sessions' })).toBeInTheDocument();
    expect(within(session).queryByRole('button', { name: /Sessions/ })).not.toBeInTheDocument();
  });

  it('shows the pairing screen until the app is paired with the Dispatcher, then the list', async () => {
    setIdiom('phone');
    const user = userEvent.setup();
    render(<MockApp scenario='unpaired' />);
    expect(screen.getByRole('heading', { name: 'Pair with your Dispatcher' })).toBeInTheDocument();
    expect(screen.queryByRole('searchbox', { name: 'Filter Sessions' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('URL'), 'wss://homelab.example.ts.net:7342');
    await user.type(screen.getByLabelText('Code'), 'ABCD');
    await user.click(screen.getByRole('button', { name: 'Pair' }));
    expect(await screen.findByRole('group', { name: 'weave' })).toBeInTheDocument();
  });

  it('says when no Host has joined the Dispatcher', () => {
    setIdiom('phone');
    render(<MockApp scenario='empty' />);
    expect(screen.getByText('No Hosts yet')).toBeInTheDocument();
    expect(screen.getByText(/No Host has joined the Dispatcher/)).toBeInTheDocument();
  });

  it("says when the Dispatcher can't be reached, and keeps the Hosts it last listed, greyed out", async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp scenario='offline' />);
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent("Can't reach the Dispatcher on homelab");
    expect(screen.getByRole('group', { name: 'build' })).toHaveAttribute('data-away', 'true');
    expect(tile(/^odin/)).toBeInTheDocument();
    await user.click(within(banner).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('group', { name: 'build' })).not.toHaveAttribute('data-away');
  });

  it("says why the Dispatcher can't reach a Host, under its name", () => {
    setIdiom('pad');
    render(<MockApp scenario='unreachable' />);
    expect(within(screen.getByRole('group', { name: 'build' })).getByText(/hasn't connected to the Dispatcher/)).toBeInTheDocument();
  });

  it('starts a Session on a Host from its heading: a thread in a directory, which opens its Session with the thread in it', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    // The list's rail has no New Session of its own: each heading's + starts one there.
    expect(screen.queryByRole('button', { name: 'New Session' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New Session on build' }));
    expect(screen.getByRole('dialog', { name: 'New Session' })).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'New Session' });
    await user.selectOptions(within(form).getByLabelText('Start with'), 'Codex');
    await user.click(within(form).getByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('region', { name: 'New thread' })).toBeInTheDocument();
    // In its directory's Session, as a Block of it, with the keyboard.
    const session = screen.getByRole('region', { name: 'Session odin' });
    expect(within(session).getByRole('group', { name: 'Block, New thread' })).toHaveAttribute('data-focused', 'true');
    expect(tile(/^odin/)).toHaveAttribute('aria-current', 'page');
  });
});

describe('a Project', () => {
  it('starts a Session in its directory from its heading, which is the one that directory has', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.click(screen.getByRole('button', { name: 'New Session in weave' }));
    const form = screen.getByRole('form', { name: 'New Session' });
    // The Project says where: no Host or directory is asked for, only which of its worktrees.
    expect(within(form).getByRole('button', { name: 'Project' })).toHaveTextContent('weave');
    expect(within(form).queryByLabelText('Directory')).not.toBeInTheDocument();
    expect(await within(form).findByRole('button', { name: 'Worktree' })).toHaveAttribute('title', '/Users/jaco/Documents/VeeZee/weave');
    await user.click(within(form).getByRole('button', { name: 'Start' }));
    const session = await screen.findByRole('region', { name: 'Session weave' });
    // A Block of the Session that directory has, with the keyboard.
    await waitFor(() => expect(within(session).getByRole('group', { name: 'Block, New thread' })).toHaveAttribute('data-focused', 'true'));
  });
});

describe('ending a Session', () => {
  it('asks first, then it’s gone for good, with what was in it', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.click(tile(/^odin/));
    expect(screen.getByRole('region', { name: 'Session odin' })).toBeInTheDocument();
    await user.pointer({ keys: '[MouseRight]', target: tile(/^odin/) });
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'End Session…' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'End odin?' });
    expect(confirm).toHaveTextContent('This closes its open thread, ends its terminals and forgets its layout, for good');
    await user.click(within(confirm).getByRole('button', { name: 'End Session' }));
    // Off the list, and off the screen.
    await waitFor(() => expect(screen.queryByRole('button', { name: /^odin/ })).not.toBeInTheDocument());
    expect(screen.queryByRole('region', { name: 'Session odin' })).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="no-session"]')).toBeInTheDocument();
  });

  it('says why not while something in it is running, and keeps it', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.pointer({ keys: '[MouseRight]', target: tile(/weave.*mac · main/) });
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'End Session…' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'End weave (main)?' });
    expect(confirm).toHaveTextContent('its 5 open threads');
    await user.click(within(confirm).getByRole('button', { name: 'End Session' }));
    expect(await within(confirm).findByText(/A thread in it is running a turn or waiting on you/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Keep it' }));
    expect(tile(/weave.*mac · main/)).toBeInTheDocument();
  });
});

describe('a Session’s last Block', () => {
  it('takes the Session with it, without asking when nothing is cut off', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.click(tile(/^odin/));
    const session = screen.getByRole('region', { name: 'Session odin' });
    await user.click(await within(session).findByRole('button', { name: 'Close Diagnose upload failures' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^odin/ })).not.toBeInTheDocument());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="no-session"]')).toBeInTheDocument();
  });

  it('leaves a Session that holds what no Block shows, with an empty tab', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.click(tile(/weave.*mac · main/));
    const session = screen.getByRole('region', { name: 'Session weave' });
    await user.click(within(session).getByRole('button', { name: 'Close Bring Alpha back' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Close Bring Alpha back?' });
    // Nothing of the Session ending: it has more than this Block.
    expect(confirm).not.toHaveTextContent('Session ends');
    await user.click(within(confirm).getByRole('button', { name: 'Close thread' }));
    expect(await within(session).findByText('Nothing in this tab')).toBeInTheDocument();
    expect(tile(/weave.*mac · main/)).toBeInTheDocument();
  });
});

describe('a Session nobody arranged', () => {
  it('shows the thread it was started with, and what else it has as not shown, to dock beside it', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    expect(document.querySelector('[data-slot="no-session"]')).toBeInTheDocument();
    await user.click(tile(/weave.*mac · main/));
    const session = screen.getByRole('region', { name: 'Session weave' });
    const alpha = within(session).getByRole('group', { name: 'Block, Bring Alpha back' });
    expect(within(session).getAllByRole('group', { name: /^Block, /u })).toHaveLength(1);
    expect(within(alpha).getByRole('region', { name: 'Bring Alpha back' })).toBeInTheDocument();
    expect(within(alpha).getByRole('textbox', { name: 'Message agent' })).toBeInTheDocument();
    // Alone in its tab, it has nothing to be told from, nor to zoom over.
    expect(session.querySelector('[data-focus-edge]')).not.toBeInTheDocument();
    expect(within(session).queryByRole('button', { name: /^Zoom /u })).not.toBeInTheDocument();
    // The list stays beside it.
    expect(screen.getByRole('group', { name: 'build' })).toBeInTheDocument();

    // Nothing else of the Session's was placed for the person: its other threads and its
    // terminals have no Block, and its closed thread opens again from the same place. New Block
    // lists them, from the Block's split, as its rail has no New Block of its own.
    expect(within(session).queryByRole('button', { name: /^New Block/ })).not.toBeInTheDocument();
    await user.click(within(alpha).getByRole('button', { name: 'Split Bring Alpha back right' }));
    // What it has that no Block shows is in this directory, its threads, then its terminals.
    const names = within(await submenu(user, 'From this directory')).getAllByRole('menuitem').map((option) => option.textContent);
    expect(names).toHaveLength(7);
    expect(names.slice(-3)).toEqual([
      expect.stringContaining('cargo test -p weave-tui'), expect.stringContaining('nvim protocol/src/terminals.rs'), expect.stringContaining('app'),
    ]);
    // Its closed threads open again from a menu of their own.
    expect(within(await submenu(user, 'Reopen thread')).getByRole('menuitem', { name: /Pencil hover/ })).toBeInTheDocument();

    // One picked docks beside the Block with the keyboard, and takes it.
    await pick(user, 'From this directory', /Nightly dependency check/u);
    const nightly = await within(session).findByRole('group', { name: 'Block, Nightly dependency check' });
    expect(within(session).getAllByRole('group', { name: /^Block, /u })).toHaveLength(2);
    expect(within(session).getAllByRole('separator', { name: 'Resize Blocks' })).toHaveLength(1);
    await waitFor(() => expect(nightly).toHaveAttribute('data-focus-edge', 'true'));
  });

  it('shows one Block at a time on an iPhone, its tab’s Blocks as a row to pick from, with Back to the list', async () => {
    setIdiom('phone');
    const user = userEvent.setup();
    render(<MockApp scenario='session' />);
    expect(screen.queryByRole('group', { name: 'build' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Update the Host protocol spec' })).toBeInTheDocument();
    // Its rail has the Blocks' names, its menu and its close: nothing to arrange them with.
    const row = screen.getByRole('tablist', { name: 'Blocks in this tab' });
    expect(screen.getByRole('button', { name: 'Close Update the Host protocol spec' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(Split|Float|Zoom|Minimize) /u })).not.toBeInTheDocument();
    // Every Block of the tab, the one put away on a bigger screen among them.
    expect(within(row).getAllByRole('tab')).toHaveLength(5);
    await user.click(within(row).getByRole('tab', { name: /Steer handling in the TUI/u }));
    expect(screen.getByRole('region', { name: 'Steer handling in the TUI' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Update the Host protocol spec' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Sessions/u }));
    expect(screen.getByRole('group', { name: 'build' })).toBeInTheDocument();
  });

  it('shows the tab in front alone on an iPhone, and lists the tabs to pick from when it’s tapped', async () => {
    setIdiom('phone');
    const user = userEvent.setup();
    render(<MockApp scenario='session' />);
    expect(screen.queryByRole('tablist', { name: 'Tabs' })).not.toBeInTheDocument();
    const picker = screen.getByRole('button', { name: /^Tab .+, 1 of \d+$/u });
    await user.click(picker);
    const tabs = screen.getAllByRole('menuitem').filter((item) => item.textContent !== 'Rename tab');
    expect(tabs.length).toBeGreaterThan(1);
    expect(tabs[0]).toHaveAttribute('aria-current', 'true');
    await user.click(tabs[1]!);
    expect(screen.getByRole('button', { name: /^Tab .+, 2 of \d+$/u })).toHaveTextContent(tabs[1]!.textContent);
  });
});

describe('a Session someone arranged', () => {
  const open = () => {
    setIdiom('pad');
    render(<MockApp scenario='session' />);
    return screen.getByRole('region', { name: 'Session weave' });
  };

  it('marks the tab in front in the list’s Threads view, and brings a tab in front from there', async () => {
    const user = userEvent.setup();
    const session = open();
    await user.click(within(screen.getByRole('tablist', { name: 'View' })).getByRole('tab', { name: 'Threads' }));
    // The tab of threads is listed, by its first thread; Notes, which has none, isn't.
    const threads = screen.getByRole('group', { name: 'Threads' });
    const tile = () => within(threads).getByRole('button', { name: /^Update the Host protocol spec.*weave · mac · main/ });
    expect(within(threads).queryByRole('button', { name: /^Notes/ })).not.toBeInTheDocument();
    expect(tile()).toHaveAttribute('aria-current', 'page');
    const tabs = within(session).getByRole('tablist', { name: 'Tabs' });
    await user.click(within(tabs).getByRole('tab', { name: 'Notes' }));
    expect(tile()).not.toHaveAttribute('aria-current');
    await user.click(tile());
    await waitFor(() => expect(within(tabs).getByRole('tab', { name: 'Update the Host protocol spec' })).toHaveAttribute('aria-selected', 'true'));
    expect(tile()).toHaveAttribute('aria-current', 'page');
  });

  it('lays its tabs out as they were arranged: Blocks docked side by side and one above another, one floating and one put away', async () => {
    const user = userEvent.setup();
    const session = open();
    const tabs = within(session).getByRole('tablist', { name: 'Tabs' });
    expect(within(tabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Update the Host protocol spec', 'Notes']);
    // No menu for the Session: each tab closes and renames itself, and a + after them adds one.
    // New Block isn't in the rail: an empty tab has it.
    expect(within(session).queryByRole('button', { name: 'Tab actions' })).not.toBeInTheDocument();
    expect(within(session).getByRole('button', { name: 'New tab' })).toBeInTheDocument();
    expect(within(session).queryByRole('button', { name: /^New Block/ })).not.toBeInTheDocument();
    // A thread beside a column of a terminal and a thread, and a terminal floating over them.
    expect(within(session).getByRole('group', { name: 'Block, Update the Host protocol spec' })).toBeInTheDocument();
    const tests = within(session).getByRole('group', { name: 'Block, cargo test -p weave-tui' });
    expect(within(tests).getByText('cargo: Testing (60%).')).toBeInTheDocument();
    expect(within(tests).getByText(/A browser doesn't draw terminals/)).toBeInTheDocument();
    expect(within(session).getByRole('group', { name: 'Block, Bring Alpha back' })).toBeInTheDocument();
    expect(within(session).getByRole('group', { name: 'Floating, app' })).toBeInTheDocument();
    expect(within(session).getAllByRole('separator', { name: 'Resize Blocks' })).toHaveLength(2);
    // Both threads on screen are followed at once, each with its own composer.
    expect(within(session).getAllByRole('textbox', { name: 'Message agent' })).toHaveLength(2);
    // One that floats was put away: its name, at the bottom right, and nothing of what it shows.
    const away = within(session).getByRole('group', { name: 'Minimized Blocks' });
    expect(within(away).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Maximize Steer handling in the TUI']);
    expect(within(session).queryByRole('region', { name: 'Steer handling in the TUI' })).not.toBeInTheDocument();
    // Nothing is behind anything: a Block has a place of its own.
    expect(within(session).queryByRole('tablist', { name: /Blocks/u })).not.toBeInTheDocument();

    // A Block of a type the app doesn't have shows as its type and props.
    await user.click(within(tabs).getByRole('tab', { name: 'Notes' }));
    const unknown = within(session).getByRole('group', { name: 'Block, weave.browser' });
    expect(within(unknown).getByText(/"url": "https:\/\/example.com\/docs"/)).toBeInTheDocument();
  });

  it('puts a floating Block away and brings one back, and trades two docked Blocks’ places', async () => {
    const user = userEvent.setup();
    const session = open();
    // Only a floating Block can be put away: as its name, under the one already there.
    expect(within(session).queryByRole('button', { name: 'Minimize Bring Alpha back' })).not.toBeInTheDocument();
    expect(within(session).getByRole('button', { name: 'Minimize app' })).toHaveAttribute('title', 'Minimize');
    await user.click(within(session).getByRole('button', { name: 'Minimize app' }));
    await waitFor(() => expect(within(session).queryByRole('group', { name: 'Floating, app' })).not.toBeInTheDocument());
    const away = within(session).getByRole('group', { name: 'Minimized Blocks' });
    expect(within(away).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Maximize Steer handling in the TUI', 'Maximize app']);
    // Its name brings it back where it floated, with the keyboard.
    await user.click(within(away).getByRole('button', { name: 'Maximize Steer handling in the TUI' }));
    const steer = await within(session).findByRole('group', { name: 'Floating, Steer handling in the TUI' });
    await waitFor(() => expect(steer).toHaveAttribute('data-focused', 'true'));
    expect(within(steer).getByRole('region', { name: 'Steer handling in the TUI' })).toBeInTheDocument();
    expect(within(away).getAllByRole('button')).toHaveLength(1);

    // A docked Block dropped on the middle of another takes its place, which takes this one's.
    const order = () => within(session).getAllByRole('group', { name: /^Block, /u }).map((group) => group.getAttribute('aria-label'));
    expect(order()).toEqual(['Block, Update the Host protocol spec', 'Block, cargo test -p weave-tui', 'Block, Bring Alpha back']);
    const spec = within(session).getByRole('group', { name: 'Block, Update the Host protocol spec' });
    spec.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
    const handle = within(session).getByRole('group', { name: 'Block, Bring Alpha back' }).querySelector('[data-slot="block-title"]') as HTMLElement;
    const elementFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => spec;
    fireEvent.pointerDown(handle, { button: 0, clientX: 900, clientY: 500 });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 300 });
    fireEvent.pointerUp(window, { clientX: 500, clientY: 300 });
    document.elementFromPoint = elementFromPoint;
    await waitFor(() => expect(order()).toEqual(['Block, Bring Alpha back', 'Block, cargo test -p weave-tui', 'Block, Update the Host protocol spec']));
  });

  it('acts in the thread a Block shows, not the one in front', async () => {
    const user = userEvent.setup();
    const session = open();
    const alpha = within(session).getByRole('group', { name: 'Block, Bring Alpha back' });
    await user.type(within(alpha).getByRole('textbox', { name: 'Message agent' }), 'Keep going');
    await user.keyboard('{Enter}');
    expect(await within(alpha).findByText('Keep going')).toBeInTheDocument();
    expect(within(within(session).getByRole('group', { name: 'Block, Update the Host protocol spec' })).queryByText('Keep going')).not.toBeInTheDocument();
  });

  it('says what failed in a thread in its own Block, not the other or above them, until it’s dismissed or tried again', async () => {
    const user = userEvent.setup();
    const session = open();
    const alpha = within(session).getByRole('group', { name: 'Block, Bring Alpha back' });
    const failing = async () => {
      await user.type(within(alpha).getByRole('textbox', { name: 'Message agent' }), MOCK_FAILS);
      await user.keyboard('{Enter}');
      return within(alpha).findByText(/the mock was asked to fail/);
    };
    await failing();
    // Once on screen: in the Block it failed in.
    expect(within(session).getAllByText(/the mock was asked to fail/)).toHaveLength(1);
    expect(within(within(session).getByRole('group', { name: 'Block, Update the Host protocol spec' })).queryByText(/the mock was asked to fail/)).not.toBeInTheDocument();

    await user.click(within(alpha).getByRole('button', { name: 'Dismiss error' }));
    expect(within(session).queryByText(/the mock was asked to fail/)).not.toBeInTheDocument();

    await failing();
    await user.type(within(alpha).getByRole('textbox', { name: 'Message agent' }), 'Keep going');
    await user.keyboard('{Enter}');
    expect(await within(alpha).findByText('Keep going')).toBeInTheDocument();
    expect(within(session).queryByText(/the mock was asked to fail/)).not.toBeInTheDocument();
  });

  it('docks a thread that wasn’t shown beside a Block, zooms a Block, and moves one to a tab of its own', async () => {
    const user = userEvent.setup();
    const session = open();
    // Every Block's rail has the same icons, whatever it shows.
    for (const name of ['Bring Alpha back', 'cargo test -p weave-tui']) {
      for (const label of [`Split ${name} right`, `Split ${name} down`, `Float ${name}`, `Zoom ${name}`, `${name} actions`, `Close ${name}`]) {
        expect(within(session).getByRole('button', { name: label })).toBeInTheDocument();
      }
    }
    // Under the pointer an icon says what it does, without the Block's name.
    const hints = within(within(session).getByRole('group', { name: 'Block, Bring Alpha back' }).querySelector('[data-slot="block-rail"]') as HTMLElement)
      .getAllByRole('button').map((button) => button.title);
    expect(hints).toEqual(['Split Right', 'Split Down', 'Float', 'Zoom', 'More', 'Close']);
    await user.click(within(session).getByRole('button', { name: 'Split Bring Alpha back right' }));
    await pick(user, 'From this directory', /Nightly dependency check/);
    const nightly = await within(session).findByRole('group', { name: 'Block, Nightly dependency check' });
    expect(within(session).getAllByRole('separator', { name: 'Resize Blocks' })).toHaveLength(3);
    // It has the keyboard, which its edge shows while there are others to tell it from.
    expect(nightly).toHaveAttribute('data-focused', 'true');
    expect(session.querySelectorAll('[data-focus-edge]')).toHaveLength(1);
    expect(nightly).toHaveAttribute('data-focus-edge', 'true');

    // Zoomed, it fills the tab alone, with no edge; again, and the others are back.
    await user.click(within(session).getByRole('button', { name: 'Zoom Nightly dependency check' }));
    expect(within(session).getAllByRole('group', { name: /^Block, / })).toHaveLength(1);
    expect(session.querySelector('[data-focus-edge]')).not.toBeInTheDocument();
    await user.click(within(session).getByRole('button', { name: 'Unzoom Nightly dependency check' }));
    expect(within(session).getAllByRole('group', { name: /^Block, / })).toHaveLength(4);

    // Its name's pill is its handle: dragged onto the + after the tabs, it moves to a tab of its own.
    const handle = within(session).getByRole('group', { name: 'Block, Nightly dependency check' }).querySelector('[data-slot="block-title"]') as HTMLElement;
    const elementFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => within(session).getByRole('button', { name: 'New tab' });
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, clientY: 60 });
    fireEvent.pointerMove(window, { clientX: 200, clientY: 20 });
    fireEvent.pointerUp(window, { clientX: 200, clientY: 20 });
    document.elementFromPoint = elementFromPoint;
    const tabs = within(session).getByRole('tablist', { name: 'Tabs' });
    await waitFor(() => expect(within(tabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Update the Host protocol spec', 'Notes', 'Nightly dependency check']));
    expect(within(tabs).getByRole('tab', { name: 'Nightly dependency check' })).toHaveAttribute('aria-selected', 'true');
  });

  it('closes the thread with its Block, asking first when a turn runs, and ends a terminal with its', async () => {
    const user = userEvent.setup();
    const session = open();
    // A thread that isn't running closes at once, and goes to the closed threads.
    await user.click(within(session).getByRole('button', { name: 'Maximize Steer handling in the TUI' }));
    await user.click(await within(session).findByRole('button', { name: 'Close Steer handling in the TUI' }));
    await waitFor(() => expect(within(session).queryByRole('group', { name: 'Floating, Steer handling in the TUI' })).not.toBeInTheDocument());
    expect(within(session).queryByRole('group', { name: 'Minimized Blocks' })).not.toBeInTheDocument();
    await user.click(within(session).getByRole('button', { name: 'Split Bring Alpha back right' }));
    expect(within(await submenu(user, 'Reopen thread')).getByRole('menuitem', { name: /Steer handling in the TUI/ })).toBeInTheDocument();
    // Escape closes the submenu, then the menu.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Reopen thread' })).not.toBeInTheDocument());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

    // One whose turn runs asks first.
    await user.click(within(session).getByRole('button', { name: 'Close Bring Alpha back' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Close Bring Alpha back?' });
    expect(confirm).toHaveTextContent('Its turn is still running');
    await user.click(within(confirm).getByRole('button', { name: 'Keep it open' }));
    expect(within(session).getByRole('group', { name: 'Block, Bring Alpha back' })).toBeInTheDocument();

    // A terminal with a command running asks too; one that ends is gone, not hidden.
    await user.click(within(session).getByRole('button', { name: 'Close cargo test -p weave-tui' }));
    const ending = await screen.findByRole('alertdialog', { name: 'End cargo test -p weave-tui?' });
    await user.click(within(ending).getByRole('button', { name: 'End terminal' }));
    await waitFor(() => expect(within(session).queryByRole('group', { name: 'Block, cargo test -p weave-tui' })).not.toBeInTheDocument());
    await user.click(within(session).getByRole('button', { name: 'Split Bring Alpha back right' }));
    expect(within(await submenu(user, 'From this directory')).queryByRole('menuitem', { name: /^cargo test/ })).not.toBeInTheDocument();
  });

  it('renames a thread in its Block’s rail, and a terminal nowhere: what’s in it names it', async () => {
    const user = userEvent.setup();
    const session = open();
    const alpha = within(session).getByRole('group', { name: 'Block, Bring Alpha back' });
    const title = (block: HTMLElement) => block.querySelector('[data-slot="block-title"] .truncate') as HTMLElement;
    await user.dblClick(title(alpha));
    const name = within(alpha).getByRole('textbox', { name: 'Block name' });
    expect(name).toHaveValue('Bring Alpha back');
    // Escape leaves it as it was.
    await user.clear(name);
    await user.type(name, 'Something else{Escape}');
    expect(title(alpha)).toHaveTextContent('Bring Alpha back');
    // Return keeps it, for every client.
    await user.dblClick(title(alpha));
    await user.clear(within(alpha).getByRole('textbox', { name: 'Block name' }));
    await user.type(within(alpha).getByRole('textbox', { name: 'Block name' }), 'Alpha, again{Enter}');
    expect(await within(session).findByRole('group', { name: 'Block, Alpha, again' })).toBeInTheDocument();
    expect(within(session).queryByRole('textbox', { name: 'Block name' })).not.toBeInTheDocument();

    // Its menu has no rename, and a terminal's name isn't anyone's to give.
    await user.click(within(session).getByRole('button', { name: 'Alpha, again actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Thread status' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Rename/u })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.dblClick(title(within(session).getByRole('group', { name: 'Block, cargo test -p weave-tui' })));
    expect(within(session).queryByRole('textbox', { name: 'Block name' })).not.toBeInTheDocument();
  });

  it('keeps a Block’s controls in a row atop it, empty until the pointer is over it, where the pointer hovers', () => {
    const session = open();
    const alpha = within(session).getByRole('group', { name: 'Block, Bring Alpha back' });
    const rail = alpha.querySelector('[data-slot="block-rail"]') as HTMLElement;
    // Two pills in a row of their own, seen while the pointer is over the row.
    expect(rail).toHaveClass('h-10', 'opacity-0', 'hover:opacity-100');
    expect(rail).toHaveClass('cursor-grab');
    expect(within(alpha).queryByRole('button', { name: 'Bring Alpha back controls' })).not.toBeInTheDocument();
  });

  describe('on a touch screen', () => {
    const coarse = (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }) as MediaQueryList;
    let matchMedia: typeof window.matchMedia;
    beforeEach(() => {
      matchMedia = window.matchMedia;
      window.matchMedia = (query: string) => query.includes('hover') ? coarse(query) : matchMedia.call(window, query);
    });
    afterEach(() => { window.matchMedia = matchMedia; });

    it('shows a Block’s controls once its strip is tapped, and puts them away again', async () => {
      const user = userEvent.setup();
      const session = open();
      const alpha = within(session).getByRole('group', { name: 'Block, Bring Alpha back' });
      const strip = within(alpha).getByRole('button', { name: 'Bring Alpha back controls' });
      expect(strip).toHaveAttribute('aria-expanded', 'false');
      expect(within(alpha).queryByRole('button', { name: 'Close Bring Alpha back' })).not.toBeInTheDocument();
      expect(alpha.querySelector('[data-slot="block-title"]')).not.toBeInTheDocument();

      // Tapped, its row has the name's pill and the icons'.
      await user.click(strip);
      expect(strip).toHaveAttribute('aria-expanded', 'true');
      expect(within(alpha).getByRole('button', { name: 'Close Bring Alpha back' })).toBeInTheDocument();
      expect(alpha.querySelector('[data-slot="block-title"]')).toHaveTextContent('Bring Alpha back');
      // A press in the Block leaves them; one outside it puts them away.
      fireEvent.pointerDown(within(alpha).getByRole('textbox', { name: 'Message agent' }));
      expect(within(alpha).getByRole('button', { name: 'Close Bring Alpha back' })).toBeInTheDocument();
      fireEvent.pointerDown(within(session).getByRole('group', { name: 'Block, Update the Host protocol spec' }));
      await waitFor(() => expect(within(alpha).queryByRole('button', { name: 'Close Bring Alpha back' })).not.toBeInTheDocument());
      expect(strip).toHaveAttribute('aria-expanded', 'false');

      // Tapping the strip again puts them away too.
      await user.click(strip);
      expect(within(alpha).getByRole('button', { name: 'Split Bring Alpha back right' })).toBeInTheDocument();
      await user.click(strip);
      expect(within(alpha).queryByRole('button', { name: 'Split Bring Alpha back right' })).not.toBeInTheDocument();
    });
  });

  it('drags the edge between two docked Blocks to share their space out again', () => {
    const session = open();
    const [edge] = within(session).getAllByRole('separator', { name: 'Resize Blocks' });
    const split = edge.parentElement as HTMLElement;
    split.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
    const shares = () => [...split.children].filter((child) => !child.hasAttribute('role')).map((child) => (child as HTMLElement).style.flex.split(' ')[0]);
    expect(shares()).toEqual(['0.55', '0.45']);
    edge.setPointerCapture = () => {};
    fireEvent.pointerDown(edge, { clientX: 550, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 300, pointerId: 1 });
    fireEvent.pointerUp(edge, { clientX: 300, pointerId: 1 });
    expect(shares()).toEqual(['0.3', '0.7']);
    // No narrower than a Block can be used at.
    fireEvent.pointerDown(edge, { clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 10, pointerId: 1 });
    fireEvent.pointerUp(edge, { clientX: 10, pointerId: 1 });
    expect(shares()).toEqual(['0.1', '0.9']);
  });

  it('puts its tabs in another order, by dragging one along the rail or by Move Tab Left and Right (WVE-232)', async () => {
    const user = userEvent.setup();
    const session = open();
    const tabs = within(session).getByRole('tablist', { name: 'Tabs' });
    const order = () => within(tabs).getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'));
    expect(order()).toEqual(['Update the Host protocol spec', 'Notes']);
    // Dragged before the first: the others make room as it goes, and it stays where it's let go.
    const notes = () => within(tabs).getByRole('tab', { name: 'Notes' });
    fireEvent.pointerDown(notes(), { button: 0, clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(notes(), { clientX: 198, pointerId: 1 });
    expect(notes()).not.toHaveAttribute('data-dragging');
    fireEvent.pointerMove(notes(), { clientX: 60, pointerId: 1 });
    expect(notes()).toHaveAttribute('data-dragging', 'true');
    expect(order()).toEqual(['Notes', 'Update the Host protocol spec']);
    fireEvent.pointerUp(notes(), { clientX: 60, pointerId: 1 });
    expect(notes()).not.toHaveAttribute('data-dragging');
    expect(order()).toEqual(['Notes', 'Update the Host protocol spec']);
    // Let go where it started, a tab stays there; so does one whose drag is cut short.
    fireEvent.pointerDown(notes(), { button: 0, clientX: 200, pointerId: 2 });
    fireEvent.pointerMove(notes(), { clientX: 400, pointerId: 2 });
    expect(order()).toEqual(['Update the Host protocol spec', 'Notes']);
    fireEvent.pointerCancel(notes(), { pointerId: 2 });
    expect(order()).toEqual(['Notes', 'Update the Host protocol spec']);
    // The commands move the tab in front.
    expect(commandOn('tab.moveLeft')).toBe(true);
    expect(commandOn('tab.moveRight')).toBe(false);
    act(() => { runCommand('tab.moveLeft'); });
    expect(order()).toEqual(['Update the Host protocol spec', 'Notes']);
    expect(commandOn('tab.moveLeft')).toBe(false);
    act(() => { runCommand('tab.moveRight'); });
    expect(order()).toEqual(['Notes', 'Update the Host protocol spec']);
    // A click still shows a tab.
    await user.click(notes());
    expect(notes()).toHaveAttribute('aria-selected', 'true');
  });

  it('renames a tab in the tab itself, adds one after the last, and closes one from its own icon, asking first', async () => {
    const user = userEvent.setup();
    const session = open();
    const tabs = within(session).getByRole('tablist', { name: 'Tabs' });
    await user.dblClick(within(tabs).getByRole('tab', { name: 'Update the Host protocol spec' }));
    const name = within(tabs).getByRole('textbox', { name: 'Tab name' });
    await user.type(name, 'Work{Enter}');
    expect(await within(tabs).findByRole('tab', { name: 'Work' })).toBeInTheDocument();
    expect(within(tabs).queryByRole('textbox')).not.toBeInTheDocument();
    // Escape leaves the name as it was.
    await user.dblClick(within(tabs).getByRole('tab', { name: 'Work' }));
    await user.type(within(tabs).getByRole('textbox', { name: 'Tab name' }), 'Scratch{Escape}');
    expect(within(tabs).getByRole('tab', { name: 'Work' })).toBeInTheDocument();

    // A new tab is made by its first Block: + asks for one, and put away it makes nothing.
    await user.click(within(session).getByRole('button', { name: 'New tab' }));
    const adding = await newBlock();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(adding).not.toBeInTheDocument());
    expect(within(tabs).getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))).toEqual(['Work', 'Notes']);
    await user.click(within(session).getByRole('button', { name: 'New tab' }));
    await pick(user, 'From this directory', /Nightly dependency check/u);
    expect(await within(tabs).findByRole('tab', { name: 'Nightly dependency check' })).toHaveAttribute('aria-selected', 'true');
    expect(within(tabs).getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))).toEqual(['Work', 'Nightly dependency check', 'Notes']);
    expect(within(session).queryByText('Nothing in this tab')).not.toBeInTheDocument();
    // Its last Block takes it along.
    await user.click(within(session).getByRole('button', { name: 'Close Nightly dependency check' }));
    await waitFor(() => expect(within(tabs).getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))).toEqual(['Work', 'Notes']));

    // One with Blocks asks, saying what closing it does.
    await user.click(within(tabs).getByRole('button', { name: 'Close tab Notes' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Close Notes?' });
    expect(confirm).toHaveTextContent('takes its Block out of the layout');
    await user.click(within(confirm).getByRole('button', { name: 'Keep it open' }));
    expect(within(tabs).getByRole('tab', { name: 'Notes' })).toBeInTheDocument();
    await user.click(within(tabs).getByRole('button', { name: 'Close tab Work' }));
    const closing = await screen.findByRole('alertdialog', { name: 'Close Work?' });
    expect(closing).toHaveTextContent('closes its 3 threads and ends its 2 terminals, and something in it is still running');
    await user.click(within(closing).getByRole('button', { name: 'Close tab' }));
    await waitFor(() => expect(within(tabs).getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))).toEqual(['Notes']));
  });
});

describe('a thread asked for from outside the shell', () => {
  it('shows in its Session, in front, in a Block of its own if it had none', async () => {
    setIdiom('pad');
    render(<MockApp scenario='session' />);
    const session = () => screen.getByRole('region', { name: /^Session / });
    // One whose Block was put away: brought back where it floated.
    act(() => requestOpenThread('host-mac/steer-tui'));
    expect(await within(session()).findByRole('group', { name: 'Floating, Steer handling in the TUI' })).toBeInTheDocument();
    expect(within(session()).getByRole('region', { name: 'Steer handling in the TUI' })).toBeInTheDocument();
    // One with none: docked in the tab, in a Block of its own.
    act(() => requestOpenThread('host-mac/nightly'));
    expect(await within(session()).findByRole('group', { name: 'Block, Nightly dependency check' })).toBeInTheDocument();
    expect(within(session()).getByRole('region', { name: 'Nightly dependency check' })).toBeInTheDocument();
    // One in another Session: that Session, with the thread.
    act(() => requestOpenThread('host-server/upload-failures'));
    expect(await screen.findByRole('region', { name: 'Session odin' })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Diagnose upload failures' })).toBeInTheDocument();
  });
});

describe('commands', () => {
  it('run from the palette, and from their keys', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp scenario='session' />);
    const session = screen.getByRole('region', { name: 'Session weave' });
    const tabs = within(session).getByRole('tablist', { name: 'Tabs' });
    // The page hears a hardware keyboard's command keys: Ctrl here, ⌘ on Apple's devices.
    fireEvent.keyDown(window, { code: 'KeyK', ctrlKey: true });
    const palette = await screen.findByRole('dialog', { name: 'Commands' });
    await user.type(within(palette).getByRole('combobox', { name: 'Find a command' }), 'new tab');
    // A menu's own commands first, in the table's order; Return runs the one picked.
    expect(within(palette).getAllByRole('option').map((option) => option.textContent)).toEqual(['TabNew TabCtrl+T', 'BlockMove to a New Tab']);
    await user.keyboard('{Enter}');
    // New Tab asks for the tab's first Block.
    await pick(user, 'From this directory', /Nightly dependency check/u);
    expect(await within(tabs).findByRole('tab', { name: 'Nightly dependency check' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(window, { code: 'BracketLeft', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(within(tabs).getByRole('tab', { name: 'Update the Host protocol spec' })).toHaveAttribute('aria-selected', 'true'));
    // Typing isn't a command.
    fireEvent.keyDown(window, { code: 'KeyT' });
    expect(screen.queryByRole('menu', { name: 'New Block' })).not.toBeInTheDocument();
    expect(within(tabs).getAllByRole('tab')).toHaveLength(3);
  });
});

describe('Hosts', () => {
  it('lists the Dispatcher and the Hosts it reaches, and forgetting it goes back to the pairing screen', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.click(screen.getByRole('button', { name: 'Connections' }));
    const hosts = await screen.findByRole('dialog', { name: 'Connections' });
    expect(within(hosts).getByRole('region', { name: 'Dispatcher' })).toHaveTextContent('Dispatcher on homelab');
    expect(within(within(hosts).getByRole('list', { name: 'Hosts' })).getAllByRole('listitem')).toHaveLength(2);
    await user.click(within(hosts).getByRole('button', { name: 'Forget the Dispatcher' }));
    await user.click(await screen.findByRole('button', { name: 'Forget Dispatcher' }));
    expect(await screen.findByRole('heading', { name: 'Pair with your Dispatcher' })).toBeInTheDocument();
  });
});

describe('on an iPad', () => {
  it('opens on the Session this device last showed', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    const { unmount } = render(<MockApp />);
    await user.click(tile(/^odin/));
    expect(screen.getByRole('region', { name: 'Session odin' })).toBeInTheDocument();
    unmount();
    render(<MockApp />);
    expect(screen.getByRole('region', { name: 'Session odin' })).toBeInTheDocument();
    expect(tile(/^odin/)).toHaveAttribute('aria-current', 'page');
  });

  it('drags the list\'s edge, or moves it with the arrow keys, and keeps the width', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    const { unmount } = render(<MockApp />);
    const edge = () => screen.getByRole('separator', { name: 'Resize Sessions' });
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

describe('a thread that starts waiting off screen', () => {
  it('raises a banner that shows it, in its Session', async () => {
    setIdiom('phone');
    const user = userEvent.setup();
    render(<MockApp scenario='banner' bannerMs={20} />);
    const banner = await screen.findByRole('status');
    expect(within(banner).getByText('Bring Alpha back needs you')).toBeInTheDocument();
    expect(within(banner).getByText('Permission to edit app/src/App.tsx')).toBeInTheDocument();
    await user.click(within(banner).getByText('Bring Alpha back needs you'));
    expect(await screen.findByRole('region', { name: 'Session weave' })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Bring Alpha back' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Bring Alpha back needs you')).not.toBeInTheDocument());
  });

  it('raises none for threads already waiting when the app opens', async () => {
    setIdiom('phone');
    render(<MockApp />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(screen.queryByText(/. needs you$/)).not.toBeInTheDocument();
  });
});

describe('the composer in a running thread', () => {
  it('queues for an agent that cannot take steers, and sends the queue when the turn ends', async () => {
    setIdiom('phone');
    const user = userEvent.setup();
    render(<MockApp scenario='running' turnMs={50} />);
    const queued = await screen.findByRole('list', { name: 'Queued messages' });
    expect(within(queued).getByText('Then regenerate the fixtures.')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Message agent' }), 'And the docs');
    await user.click(screen.getByRole('button', { name: 'Queue message' }));
    expect(within(screen.getByRole('list', { name: 'Queued messages' })).getByText('And the docs')).toBeInTheDocument();
  });
});

describe('the Session this device last showed', () => {
  it('is asked for again once the controller can show it, as at launch, before the store is there', () => {
    saveLastSession('mac//work/weave');
    const model: AppModel = { starting: true, hosts: [], threads: [], agents: {}, unread: new Set() };
    const idle = {} as AppController['actions'];
    const { rerender } = render(<AppShell controller={{ model, actions: idle }} />);
    const selectSession = vi.fn();
    rerender(<AppShell controller={{ model, actions: { ...idle, selectSession } }} />);
    expect(selectSession).toHaveBeenCalledWith('mac//work/weave');
  });
});

describe('Projects (WVE-220)', () => {
  const heading = (name: string) => screen.getByRole('group', { name }).querySelector('[data-sidebar="group-label"]') as HTMLElement;
  const menu = async (name: string) => {
    fireEvent.contextMenu(heading(name));
    return screen.findByRole('menu');
  };

  it('heads the Projects under a divider from the Bots, with Add Project as an icon there', () => {
    setIdiom('pad');
    render(<MockApp />);
    const projects = screen.getByRole('heading', { name: 'Projects' });
    const divider = document.querySelector('[data-sidebar="separator"]') as HTMLElement;
    const after = (earlier: Node, later: Node) => Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(after(screen.getByRole('group', { name: 'Bots' }), divider)).toBe(true);
    expect(after(divider, projects)).toBe(true);
    expect(after(projects, screen.getByRole('group', { name: 'weave' }))).toBe(true);
    const add = screen.getByRole('button', { name: 'Add Project' });
    expect(add).toHaveTextContent('');
    expect((projects.parentElement as HTMLElement).contains(add)).toBe(true);
    // A Project's icon is green, a Host's peach.
    // A Project's icon is green, a Host's peach, each with a chevron at the row's end; a Host with nothing to fold has the icon alone.
    expect(heading('weave').querySelectorAll('svg')[0]).toHaveClass('text-green');
    expect(heading('build').querySelectorAll('svg')[0]).toHaveClass('text-peach');
    expect(heading('build').querySelectorAll('svg')).toHaveLength(2);
    expect([...heading('mac').querySelectorAll('svg')].map((icon) => icon.classList.contains('text-peach'))).toEqual([true]);
  });

  it('adds a directory as a Project from the list, named after it, and puts its Sessions under it', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.click(screen.getByRole('button', { name: 'Add Project' }));
    const dialog = screen.getByRole('dialog', { name: 'Add Project' });
    const form = within(dialog).getByRole('form', { name: 'Add Project' });
    await user.selectOptions(within(form).getByLabelText('Host'), 'build');
    await user.click(within(form).getByRole('button', { name: 'Directory' }));
    await user.click(within(within(dialog).getByRole('list', { name: 'Recent directories' })).getByTitle('/srv/odin'));
    await waitFor(() => expect(within(form).getByLabelText('Name')).toHaveValue('odin'));
    await user.click(within(form).getByRole('button', { name: 'Add Project' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Project' })).not.toBeInTheDocument());
    // The Session that directory had is the Project's now, and the Host has none of its own left.
    expect(within(screen.getByRole('group', { name: 'odin' })).getByRole('button', { name: /^odin.*build/ })).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'build' })).queryByRole('button', { name: /^odin/ })).not.toBeInTheDocument();
  });

  it('offers a clone of a Project’s repository to that Project, as another Host’s location of it', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.click(screen.getByRole('button', { name: 'Add Project' }));
    const dialog = screen.getByRole('dialog', { name: 'Add Project' });
    const form = within(dialog).getByRole('form', { name: 'Add Project' });
    await user.selectOptions(within(form).getByLabelText('Host'), 'build');
    await user.click(within(form).getByRole('button', { name: 'Directory' }));
    await user.click(within(within(dialog).getByRole('list', { name: 'Directories' })).getByRole('button', { name: 'weave' }));
    await user.click(within(dialog).getByRole('button', { name: 'Use this directory' }));
    // It's the weave Project's repository: joining it is the default, and no name is asked for.
    expect(await within(form).findByLabelText('Project')).toHaveValue('p-weave');
    expect(form).toHaveTextContent('weave has this repository on mac.');
    expect(within(form).queryByLabelText('Name')).not.toBeInTheDocument();
    // Or a Project of its own, which needs a name no other has.
    await user.selectOptions(within(form).getByLabelText('Project'), 'A Project of its own');
    expect(within(form).getByLabelText('Name')).toHaveValue('weave');
    await user.click(within(form).getByRole('button', { name: 'Add Project' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent("there's a Project called weave already");
    await user.selectOptions(within(form).getByLabelText('Project'), 'Add this clone to weave');
    await user.click(within(form).getByRole('button', { name: 'Add to weave' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Project' })).not.toBeInTheDocument());
    // The Project is on both Hosts now, and can lose either.
    const items = within(await menu('weave')).getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual(['Rename…', 'Remove from mac…', 'Remove from build…', 'Remove Project…']);
  });

  it('says a directory is a Project’s already, and uses that Project', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.click(screen.getByRole('button', { name: 'Add Project' }));
    const dialog = screen.getByRole('dialog', { name: 'Add Project' });
    const form = within(dialog).getByRole('form', { name: 'Add Project' });
    await user.click(within(form).getByRole('button', { name: 'Directory' }));
    // A worktree of the repository is the repository's Project too.
    await user.click(within(within(dialog).getByRole('list', { name: 'Recent directories' })).getAllByRole('button', { name: /weave/ })[0]);
    expect(await within(form).findByRole('status')).toHaveTextContent('weave has this repository on mac already.');
    expect(within(form).getByRole('button', { name: 'Use weave' })).toBeEnabled();
  });

  it('renames a Project, takes a location from it and removes it, from its heading’s menu', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.click(within(await menu('weave')).getByRole('menuitem', { name: 'Rename…' }));
    const rename = await screen.findByRole('dialog', { name: 'Rename weave' });
    await user.clear(within(rename).getByLabelText('Name'));
    await user.type(within(rename).getByLabelText('Name'), 'loom');
    await user.click(within(rename).getByRole('button', { name: 'Rename' }));
    expect(await screen.findByRole('group', { name: 'loom' })).toBeInTheDocument();

    // Without its location on the Mac, its Sessions there list under the Mac.
    await user.click(within(await menu('loom')).getByRole('menuitem', { name: 'Remove from mac…' }));
    const location = await screen.findByRole('dialog', { name: 'Remove loom from mac?' });
    await user.click(within(location).getByRole('button', { name: 'Remove location' }));
    expect(await screen.findByRole('group', { name: 'mac' })).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'loom' })).getByText('No Sessions yet')).toBeInTheDocument();
    // With no Host to start on, its + is off.
    expect(screen.getByRole('button', { name: 'New Session in loom' })).toBeDisabled();

    await user.click(within(await menu('loom')).getByRole('menuitem', { name: 'Remove Project…' }));
    const remove = await screen.findByRole('dialog', { name: 'Remove loom?' });
    expect(remove).toHaveTextContent('Its directories stay');
    await user.click(within(remove).getByRole('button', { name: 'Remove Project' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'loom' })).not.toBeInTheDocument());
  });
});

describe('New Session (WVE-220)', () => {
  it('opens on the Projects, picked with the keyboard, and starts in one with a terminal', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    // No button for it in the list's rail: a heading's + starts one there, and the command one anywhere.
    act(() => { runCommand('session.new'); });
    const dialog = screen.getByRole('dialog', { name: 'New Session' });
    const find = within(dialog).getByRole('combobox', { name: 'Find a Project' });
    expect(find).toHaveFocus();
    const listed = () => within(within(dialog).getByRole('listbox', { name: 'Projects' })).getAllByRole('option').map((option) => option.textContent);
    expect(listed()).toEqual(['weavemac', 'Add Project…', 'Other directory…']);
    // Typing narrows the Projects; what's after them stays.
    await user.type(find, 'zzz');
    expect(listed()).toEqual(['Add Project…', 'Other directory…']);
    await user.clear(find);
    await user.keyboard('{ArrowDown}{ArrowUp}{Enter}');
    const form = within(dialog).getByRole('form', { name: 'New Session' });
    expect(within(form).getByRole('button', { name: 'Project' })).toHaveTextContent('weave');
    // On one Host, so none is asked for.
    expect(within(form).queryByLabelText('Host')).not.toBeInTheDocument();
    // Another of its worktrees, and a terminal instead of a thread.
    await user.click(await within(form).findByRole('button', { name: 'Worktree' }));
    await user.click(within(within(dialog).getByRole('list', { name: 'Worktrees' })).getByRole('button', { name: /fix-reconnect/ }));
    await user.selectOptions(within(form).getByLabelText('Start with'), 'Terminal');
    await user.click(within(form).getByRole('button', { name: 'Start' }));
    const session = await screen.findByRole('region', { name: 'Session weave.fix-reconnect' });
    await waitFor(() => expect(within(session).getByRole('group', { name: 'Block, weave.fix-reconnect' })).toHaveAttribute('data-focused', 'true'));

    // What it started with is what the next one offers first.
    await user.click(screen.getByRole('button', { name: 'New Session in weave' }));
    expect(within(screen.getByRole('form', { name: 'New Session' })).getByLabelText('Start with')).toHaveDisplayValue('Terminal');
  });

  it('starts in another directory, on the Host and with the agent this device used last', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    // No button for it in the list's rail: a heading's + starts one there, and the command one anywhere.
    act(() => { runCommand('session.new'); });
    await user.click(within(screen.getByRole('dialog', { name: 'New Session' })).getByRole('option', { name: 'Other directory…' }));
    const form = screen.getByRole('form', { name: 'New Session' });
    expect(within(form).getByRole('button', { name: 'Project' })).toHaveTextContent('None: another directory');
    await user.selectOptions(within(form).getByLabelText('Host'), 'build');
    // A Host without terminals offers none.
    expect(within(within(form).getByLabelText('Start with')).queryByRole('option', { name: 'Terminal' })).not.toBeInTheDocument();
    await user.selectOptions(within(form).getByLabelText('Start with'), 'Codex');
    await user.click(within(form).getByRole('button', { name: 'Start' }));
    await screen.findByRole('region', { name: 'Session odin' });

    // No button for it in the list's rail: a heading's + starts one there, and the command one anywhere.
    act(() => { runCommand('session.new'); });
    await user.click(within(screen.getByRole('dialog', { name: 'New Session' })).getByRole('option', { name: 'Other directory…' }));
    const again = screen.getByRole('form', { name: 'New Session' });
    expect(within(again).getByLabelText('Host')).toHaveDisplayValue('build');
    expect(within(again).getByLabelText('Start with')).toHaveDisplayValue('Codex');
  });

  it('adds a Project on the way, and opens again with it chosen', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    // No button for it in the list's rail: a heading's + starts one there, and the command one anywhere.
    act(() => { runCommand('session.new'); });
    await user.click(within(screen.getByRole('dialog', { name: 'New Session' })).getByRole('option', { name: 'Add Project…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add Project' });
    const form = within(dialog).getByRole('form', { name: 'Add Project' });
    await user.selectOptions(within(form).getByLabelText('Host'), 'build');
    await user.click(within(form).getByRole('button', { name: 'Directory' }));
    await user.click(within(within(dialog).getByRole('list', { name: 'Recent directories' })).getByTitle('/srv/odin'));
    await waitFor(() => expect(within(form).getByLabelText('Name')).toHaveValue('odin'));
    await user.click(within(form).getByRole('button', { name: 'Add Project' }));
    const session = within(await screen.findByRole('dialog', { name: 'New Session' })).getByRole('form', { name: 'New Session' });
    expect(within(session).getByRole('button', { name: 'Project' })).toHaveTextContent('odin');
  });
});

describe('New Block (WVE-220)', () => {
  const openSession = () => {
    setIdiom('pad');
    render(<MockApp scenario='session' />);
    return screen.getByRole('region', { name: 'Session weave' });
  };

  it('starts a thread with an agent from its submenu, the agent used last first', async () => {
    const user = userEvent.setup();
    const session = openSession();
    await user.click(within(session).getByRole('button', { name: 'Split Bring Alpha back right' }));
    // No search, nothing said of what's not there: what's new, then what there is.
    const menu = await newBlock();
    expect(within(menu).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['New thread', 'New terminal', 'Reopen thread', 'From this directory']);
    const agents = await submenu(user, 'New thread');
    expect(within(agents).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Claude', 'Codex', 'Gemini']);
    await user.click(within(agents).getByRole('menuitem', { name: 'Codex' }));
    // Nothing more to ask: the thread is in a Block, with the keyboard.
    await waitFor(() => expect(within(session).getByRole('group', { name: 'Block, New thread' })).toHaveAttribute('data-focused', 'true'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await user.click(within(session).getByRole('button', { name: 'Split Bring Alpha back right' }));
    expect(within(await submenu(user, 'New thread')).getAllByRole('menuitem')[0]).toHaveTextContent('Codex');
  });

  it('is driven from the keyboard: the arrows open a submenu, and Return shows what’s picked', async () => {
    const user = userEvent.setup();
    const session = openSession();
    fireEvent.keyDown(window, { code: 'KeyO', ctrlKey: true });
    await newBlock();
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowRight}');
    const directory = await screen.findByRole('menu', { name: 'From this directory' });
    await waitFor(() => expect(within(directory).getAllByRole('menuitem')[0]).toHaveFocus());
    expect(within(directory).getAllByRole('menuitem')[0]).toHaveTextContent('Nightly dependency check');
    await user.keyboard('{Enter}');
    expect(await within(session).findByRole('group', { name: 'Block, Nightly dependency check' })).toHaveAttribute('data-focused', 'true');
  });

  it('starts a thread with the agent used last from ⌘N, without asking', async () => {
    const user = userEvent.setup();
    const session = openSession();
    await user.click(within(session).getByRole('button', { name: 'Split Bring Alpha back right' }));
    await pick(user, 'New thread', 'Gemini');
    await waitFor(() => expect(within(session).getByRole('group', { name: 'Block, New thread' })).toBeInTheDocument());
    fireEvent.keyDown(window, { code: 'KeyN', ctrlKey: true });
    await waitFor(() => expect(within(session).getAllByRole('group', { name: 'Block, New thread' })).toHaveLength(2));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
