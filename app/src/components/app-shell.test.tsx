import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe('the list of Sessions', () => {
  it('puts a Project’s Sessions together with their Host and branch, and the rest under their Hosts, a Host with none left out', () => {
    setIdiom('phone');
    render(<MockApp />);
    const weave = screen.getByRole('group', { name: 'weave' });
    // The repository's worktrees are a Session each, whichever directory in them a thread runs in.
    expect(within(weave).getByRole('button', { name: /weave.*mac · main/ })).toBeInTheDocument();
    const reconnect = within(weave).getByRole('button', { name: /weave.*mac · fix-reconnect/ });
    // A thread waiting on the person marks its Session's tile.
    expect(within(reconnect).getByRole('img', { name: 'Waiting for you' })).toBeInTheDocument();
    expect(reconnect).toHaveTextContent('1 waiting on you');
    // Nothing of the Mac's is outside the Project, so it's no heading; the other Host's directory is in none.
    expect(screen.queryByRole('group', { name: 'mac' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'build' })).getByRole('button', { name: /^odin.*\/srv\/odin/ })).toBeInTheDocument();
    // Threads aren't listed: a Session's are inside it.
    expect(screen.queryByText('Bring Alpha back')).not.toBeInTheDocument();
    // Nor is a Session made up for a worktree whose thread closed before its Host kept any.
    expect(screen.queryByRole('button', { name: /old-spike/ })).not.toBeInTheDocument();
    expect(within(weave).getAllByRole('button', { name: /mac · / })).toHaveLength(2);
  });

  it('filters Sessions', async () => {
    setIdiom('phone');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.type(screen.getByRole('searchbox', { name: 'Filter Sessions' }), 'odin');
    expect(tile(/^odin/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'weave' })).not.toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox', { name: 'Filter Sessions' }));
    await user.type(screen.getByRole('searchbox', { name: 'Filter Sessions' }), 'reconnect');
    expect(within(screen.getByRole('group', { name: 'weave' })).getAllByRole('button', { name: /mac · / })).toHaveLength(1);
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
    // What adds to the list of Sessions says Session.
    expect(screen.getByRole('button', { name: 'New Session' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New Session on build' }));
    expect(screen.getByRole('dialog', { name: 'New Session' })).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'New Session' });
    await user.selectOptions(within(form).getByLabelText('Agent'), 'Codex');
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
    expect(within(form).getByRole('button', { name: 'Directory' })).toHaveAttribute('title', '/Users/jaco/Documents/VeeZee/weave');
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
    expect(screen.getByText('No Session open')).toBeInTheDocument();
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

describe('a Session nobody arranged', () => {
  it('shows the thread it was started with, and what else it has as not shown, to dock beside it', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    expect(screen.getByText('No Session open')).toBeInTheDocument();
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
    // terminals have no Block, and its closed thread opens again from the same place.
    await user.click(within(session).getByRole('button', { name: 'New Block, 7 not shown' }));
    const dialog = await screen.findByRole('dialog', { name: 'New Block' });
    const hidden = within(dialog).getByRole('group', { name: 'Not shown' });
    const names = within(hidden).getAllByRole('button').map((button) => button.textContent);
    expect(names).toHaveLength(7);
    expect(names.slice(-3)).toEqual([
      expect.stringContaining('cargo test -p weave-tui'), expect.stringContaining('nvim protocol/src/terminals.rs'), expect.stringContaining('app'),
    ]);
    expect(within(within(dialog).getByRole('group', { name: 'Closed threads' })).getByRole('button', { name: /Pencil hover/ })).toBeInTheDocument();

    // One picked docks beside the Block with the keyboard, and takes it.
    await user.click(within(hidden).getByRole('button', { name: /Nightly dependency check/u }));
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
});

describe('a Session someone arranged', () => {
  const open = () => {
    setIdiom('pad');
    render(<MockApp scenario='session' />);
    return screen.getByRole('region', { name: 'Session weave' });
  };

  it('lays its tabs out as they were arranged: Blocks docked side by side and one above another, one floating and one put away', async () => {
    const user = userEvent.setup();
    const session = open();
    const tabs = within(session).getByRole('tablist', { name: 'Tabs' });
    expect(within(tabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Update the Host protocol spec', 'Notes']);
    // No menu for the Session: each tab closes and renames itself, and a + after them adds one.
    expect(within(session).queryByRole('button', { name: 'Tab actions' })).not.toBeInTheDocument();
    expect(within(tabs).getByRole('button', { name: 'New tab' })).toBeInTheDocument();
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
    const rail = within(session).getByRole('group', { name: 'Block, Bring Alpha back' }).querySelector('[data-slot="block-rail"]') as HTMLElement;
    const elementFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => spec;
    fireEvent.pointerDown(rail, { button: 0, clientX: 900, clientY: 500 });
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
    const dialog = await screen.findByRole('dialog', { name: 'New Block' });
    await user.click(within(dialog).getByRole('button', { name: /Nightly dependency check/ }));
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

    // Its rail is its handle: dragged onto the + after the tabs, it moves to a tab of its own.
    const rail = within(session).getByRole('group', { name: 'Block, Nightly dependency check' }).querySelector('[data-slot="block-rail"]') as HTMLElement;
    const elementFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => within(session).getByRole('button', { name: 'New tab' });
    fireEvent.pointerDown(rail, { button: 0, clientX: 300, clientY: 60 });
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
    await user.click(within(session).getByRole('button', { name: /^New Block/ }));
    const dialog = await screen.findByRole('dialog', { name: 'New Block' });
    expect(within(within(dialog).getByRole('group', { name: 'Closed threads' })).getByRole('button', { name: /Steer handling in the TUI/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');

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
    await user.click(within(session).getByRole('button', { name: /^New Block/ }));
    expect(within(await screen.findByRole('dialog', { name: 'New Block' })).queryByRole('button', { name: /^cargo test/ })).not.toBeInTheDocument();
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

    await user.click(within(tabs).getByRole('button', { name: 'New tab' }));
    expect(await within(tabs).findByRole('tab', { name: 'Empty tab' })).toHaveAttribute('aria-selected', 'true');
    expect(within(session).getByText('Nothing in this tab')).toBeInTheDocument();
    expect(within(tabs).getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))).toEqual(['Work', 'Empty tab', 'Notes']);
    // An empty tab has nothing to lose, and closes without asking.
    await user.click(within(tabs).getByRole('button', { name: 'Close tab Empty tab' }));
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
    expect(await within(tabs).findByRole('tab', { name: 'Empty tab' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(window, { code: 'BracketLeft', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(within(tabs).getByRole('tab', { name: 'Update the Host protocol spec' })).toHaveAttribute('aria-selected', 'true'));
    // Typing isn't a command.
    fireEvent.keyDown(window, { code: 'KeyT' });
    expect(within(tabs).getAllByRole('tab')).toHaveLength(3);
  });
});

describe('Hosts', () => {
  it('lists the Dispatcher and the Hosts it reaches, and forgetting it goes back to the pairing screen', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.click(screen.getByRole('button', { name: 'Hosts' }));
    const hosts = await screen.findByRole('dialog', { name: 'Hosts' });
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
