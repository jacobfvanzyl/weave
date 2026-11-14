import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppController } from '@/app/app-controller';
import { requestOpenThread } from '@/app/open-thread';
import { useMockController } from '@/app/use-mock-controller';
import { AppShell } from '@/components/app-shell';
import { BotList } from './bot-list';

function MockApp({ turnMs, change }: { turnMs?: number; change?(controller: AppController): AppController }) {
  const controller = useMockController('list', { turnMs });
  return <AppShell controller={change ? change(controller) : controller} />;
}

const setIdiom = (idiom?: 'phone' | 'pad') => {
  if (idiom) document.documentElement.dataset.deviceIdiom = idiom;
  else delete document.documentElement.dataset.deviceIdiom;
};

beforeEach(() => localStorage.clear());
afterEach(() => setIdiom());

const bots = () => screen.getByRole('group', { name: 'Bots' });
const botRow = (name: string) => within(bots()).getByRole('button', { name: new RegExp(`\\b${name}\\b`) });

describe('the Bots in the list', () => {
  it('lists each Bot above the Projects, with what it is doing', () => {
    setIdiom('pad');
    render(<MockApp />);
    const group = bots();
    // Above the Projects.
    expect(group.compareDocumentPosition(screen.getByRole('group', { name: 'weave' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(botRow('Scout')).toHaveTextContent('needs you');
    expect(botRow('Builder')).toHaveTextContent('working');
    expect(botRow('Reader')).toHaveTextContent('unread');
    expect(botRow('Gardener')).toHaveTextContent('idle');
    expect(botRow('Archivist')).toHaveTextContent('away');
    expect(botRow('Sentinel')).toHaveTextContent('needs you · paused');
    expect(botRow('Courier')).toHaveTextContent('starting a new thread');
    expect(within(group).getByRole('button', { name: 'New Bot' })).toBeEnabled();
    // A Bot's home is no Session of its own in the list.
    expect(screen.queryByRole('button', { name: /^scout/ })).not.toBeInTheDocument();
  });

  it("shows each Bot's avatar, its emoji on its colour, and the robot for one with neither", async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    const avatar = (row: HTMLElement) => row.querySelector('[data-slot="bot-avatar"]') as HTMLElement;
    expect(avatar(botRow('Scout'))).toHaveTextContent('🦉');
    expect(avatar(botRow('Scout'))).toHaveAttribute('data-color', 'purple');
    // A colour alone keeps the robot; neither is the Bot as it was drawn before.
    expect(avatar(botRow('Gardener'))).toHaveAttribute('data-color', 'green');
    expect(avatar(botRow('Gardener')).querySelector('svg')).toBeInTheDocument();
    expect(avatar(botRow('Reader'))).not.toHaveAttribute('data-color');
    expect(avatar(botRow('Reader')).querySelector('svg')).toBeInTheDocument();
    // Its state's dot stays at the avatar's corner.
    expect(within(avatar(botRow('Scout'))).getByRole('img', { name: 'needs you' })).toBeInTheDocument();
    // And atop its Session.
    await user.click(botRow('Scout'));
    expect(avatar(await screen.findByRole('button', { name: /^Scout, .*: about this Bot/ }))).toHaveTextContent('🦉');
  });

  it('says nothing of Bots for a Dispatcher that keeps none, and offers no New Bot where it makes no homes', () => {
    const props = { unread: new Set<string>(), canStart: true, query: '', onOpen() {}, onNewBot() {} };
    const { rerender } = render(<BotList bots={[]} canAdd {...props} />);
    expect(screen.getByRole('button', { name: 'New Bot' })).toBeInTheDocument();
    expect(screen.getByText(/No Bots yet/)).toBeInTheDocument();
    rerender(<BotList bots={[]} canAdd={false} {...props} />);
    expect(screen.queryByRole('button', { name: 'New Bot' })).not.toBeInTheDocument();
    setIdiom('pad');
    rerender(<MockApp change={({ model, actions }) => ({ model: { ...model, bots: undefined, canAddBots: undefined }, actions })} />);
    expect(screen.queryByRole('group', { name: 'Bots' })).not.toBeInTheDocument();
  });
});

describe("a Bot's Session", () => {
  it('has no tabs, and its thread at the top left with no close, and offers no second thread', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.click(botRow('Scout'));
    const view = await screen.findByRole('region', { name: 'Bot Scout' });
    expect(within(view).queryByRole('tablist', { name: 'Tabs' })).not.toBeInTheDocument();
    expect(within(view).queryByRole('button', { name: 'New tab' })).not.toBeInTheDocument();
    const block = await within(view).findByRole('group', { name: 'Block, Morning sweep of the issue tracker' });
    expect(within(block).queryByRole('button', { name: /^Close/ })).not.toBeInTheDocument();
    expect(within(block).queryByRole('button', { name: /^Float/ })).not.toBeInTheDocument();
    // No New Block in its title row, as in any Session's: its Block's splits open it, and it
    // offers terminals, and no thread.
    expect(within(view).queryByRole('button', { name: /^New Block/ })).not.toBeInTheDocument();
    await user.click(within(block).getByRole('button', { name: /^Split .* right/ }));
    const menu = await screen.findByRole('menu', { name: 'New Block' });
    expect(within(menu).queryByRole('menuitem', { name: /^New thread/ })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'New terminal' })).toBeInTheDocument();
  });

  it('starts a Bot with no thread on its first prompt, and carries on in the thread it gets', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp turnMs={50} />);
    await user.click(botRow('Newcomer'));
    const view = await screen.findByRole('region', { name: 'Bot Newcomer' });
    expect(within(view).getByText(/has no thread yet/)).toBeInTheDocument();
    await user.type(within(view).getByRole('textbox', { name: 'Message agent' }), 'Hello there');
    await user.keyboard('{Enter}');
    expect(await within(view).findByText(/Starting Newcomer's first thread/)).toBeInTheDocument();
    // The thread it gets has its Block, top left, with the prompt in it.
    const block = await screen.findByRole('group', { name: 'Block, Hello there' }, { timeout: 3000 });
    expect(within(block).getAllByText('Hello there').length).toBeGreaterThan(0);
  });

  it('follows the Bot to its new thread', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp turnMs={50} />);
    await user.click(botRow('Gardener'));
    await screen.findByRole('group', { name: 'Block, Tidying the docs' });
    await user.click(screen.getByRole('button', { name: /^Gardener, idle: about this Bot/ }));
    const page = await screen.findByRole('dialog', { name: /Gardener/ });
    await user.click(within(page).getByRole('button', { name: 'New thread' }));
    await user.click(await screen.findByRole('button', { name: 'Start a new thread' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Gardener/ })).not.toBeInTheDocument());
    expect(await screen.findByRole('group', { name: 'Block, Gardener, carrying on' }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Block, Tidying the docs' })).not.toBeInTheDocument();
  });

  it('opens from a waiting thread of the Bot, as any thread in a Session does', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    // As a notification's click or a `weave://thread` link asks.
    act(() => requestOpenThread('host-mac/b-sentinel-now'));
    expect(await screen.findByRole('region', { name: 'Bot Sentinel' })).toBeInTheDocument();
    expect(botRow('Sentinel')).toHaveAttribute('aria-current', 'page');
    // What waits on the person counts the Bots too, but the one on screen: a Session's thread and Scout.
    expect(screen.getByRole('button', { name: /Hide Sessions/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Hide Sessions/ }));
    expect(screen.getByRole('button', { name: 'Show Sessions, 2 waiting' })).toBeInTheDocument();
  });
});

describe("a Bot's page", () => {
  const openPage = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await user.click(botRow(name));
    await user.click(await screen.findByRole('button', { name: new RegExp(`^${name}, .*: about this Bot`) }));
    return screen.findByRole('dialog', { name: new RegExp(name) });
  };

  it('shows what it is, its schedules with their actions, and its earlier threads to read', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    const page = await openPage(user, 'Gardener');
    expect(within(page).getByText('Scout')).toBeInTheDocument();
    expect(within(page).getByText('/Users/jaco/bots/gardener')).toBeInTheDocument();
    expect(within(page).getByLabelText('New thread daily at')).toHaveValue('07:00');
    expect(within(page).getByText(/Asks you before anything/)).toBeInTheDocument();
    const schedules = within(page).getByRole('list', { name: 'Schedules and wake-ups' });
    expect(await within(schedules).findByText('weekly-prune')).toBeInTheDocument();
    await user.click(within(schedules).getByRole('button', { name: 'Pause weekly-prune' }));
    expect(await within(schedules).findByRole('button', { name: 'Resume weekly-prune' })).toBeInTheDocument();
    await user.click(within(schedules).getByRole('button', { name: 'Remove weekly-prune' }));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(within(schedules).queryByText('weekly-prune')).not.toBeInTheDocument());
    // Its earlier threads, newest first, each to read without a composer.
    const earlier = within(page).getByRole('region', { name: 'Earlier threads' });
    const rows = within(earlier).getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining('Dependency updates'), expect.stringContaining('Pruning stale branches')]);
    await user.click(rows[0]);
    const reader = await screen.findByRole('dialog', { name: 'Dependency updates' });
    expect(within(reader).queryByRole('textbox', { name: 'Message agent' })).not.toBeInTheDocument();
  });

  it('says when its schedules are paused, and why', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    const page = await openPage(user, 'Sentinel');
    expect(within(page).getByText(/Its schedules are paused: a request in its thread has waited/)).toBeInTheDocument();
    expect(await within(page).findByText('Paused: paused by you')).toBeInTheDocument();
  });

  it("lists the threads it started elsewhere by Project and Host, and gives one a Block in its directory's Session", async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    const page = await openPage(user, 'Scout');
    const elsewhere = within(page).getByRole('region', { name: 'Started elsewhere' });
    expect(within(within(elsewhere).getByRole('group', { name: 'weave' })).getByText('Fix the broken docs link')).toBeInTheDocument();
    expect(within(within(elsewhere).getByRole('group', { name: 'build' })).getByText('Check the upload quota')).toBeInTheDocument();
    await user.click(within(elsewhere).getByText('Fix the broken docs link'));
    expect(await screen.findByRole('region', { name: 'Session weave.docs-link' })).toBeInTheDocument();
    expect(await screen.findByRole('group', { name: 'Block, Fix the broken docs link' })).toBeInTheDocument();
  });

  it('picks its avatar: an emoji offered or typed, a colour, and Reset for neither', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    const page = await openPage(user, 'Reader');
    const toggle = within(page).getByRole('button', { name: "Change Reader's avatar" });
    const avatar = () => toggle.querySelector('[data-slot="bot-avatar"]') as HTMLElement;
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    const picker = within(page).getByRole('group', { name: "Reader's avatar" });
    expect(within(picker).getByRole('button', { name: 'Reset' })).toBeDisabled();
    await user.click(within(picker).getByRole('radio', { name: '📚' }));
    await waitFor(() => expect(avatar()).toHaveTextContent('📚'));
    expect(within(picker).getByRole('radio', { name: '📚' })).toBeChecked();
    await user.click(within(picker).getByRole('radio', { name: 'Blue' }));
    await waitFor(() => expect(avatar()).toHaveAttribute('data-color', 'blue'));
    expect(avatar()).toHaveTextContent('📚');
    // Any other emoji is typed; a word isn't one.
    const typed = within(picker).getByRole('textbox', { name: 'Another emoji' });
    await user.type(typed, 'book');
    expect(within(picker).getByRole('button', { name: 'Use' })).toBeDisabled();
    await user.clear(typed);
    await user.type(typed, '🪐');
    await user.click(within(picker).getByRole('button', { name: 'Use' }));
    await waitFor(() => expect(avatar()).toHaveTextContent('🪐'));
    expect(typed).toHaveValue('');
    await user.click(within(picker).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(avatar()).not.toHaveAttribute('data-color'));
    expect(avatar().querySelector('svg')).toBeInTheDocument();
    // The list shows what was picked too.
    await user.click(within(picker).getByRole('radio', { name: '🦊' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(botRow('Reader').querySelector('[data-slot="bot-avatar"]')).toHaveTextContent('🦊'));
  });

  it("offers no picker on a Dispatcher that keeps no avatars", async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp change={({ model, actions }) => ({ model: { ...model, canSetBotAvatars: undefined }, actions })} />);
    const page = await openPage(user, 'Reader');
    expect(within(page).queryByRole('button', { name: "Change Reader's avatar" })).not.toBeInTheDocument();
  });

  it('renames it, and removes it, after which its home is an ordinary Session', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.click(botRow('Reader'));
    // Prompted, its home has a Session its Host keeps.
    await user.type(await screen.findByRole('textbox', { name: 'Message agent' }), 'What is new?');
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('button', { name: /^Reader, .*: about this Bot/ }));
    const page = await screen.findByRole('dialog', { name: /Reader/ });
    const name = within(page).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Librarian');
    await user.click(within(page).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('dialog', { name: /Librarian/ })).toBeInTheDocument();
    await user.click(within(page).getByRole('button', { name: 'Remove' }));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Librarian/ })).not.toBeInTheDocument());
    expect(within(bots()).queryByRole('button', { name: /Librarian/ })).not.toBeInTheDocument();
    // Its home is no Bot's now: its Session is listed under its Host, and on screen.
    expect(await screen.findByRole('region', { name: 'Session reader' })).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'mac' })).getByRole('button', { name: /reader/ })).toBeInTheDocument();
  });
});

describe('New Bot', () => {
  it('adds a Bot on a connected Host with one of its agents, and opens it; it says why not inline', async () => {
    setIdiom('pad');
    const user = userEvent.setup();
    render(<MockApp />);
    await user.click(within(bots()).getByRole('button', { name: 'New Bot' }));
    const dialog = await screen.findByRole('dialog', { name: 'New Bot' });
    await user.type(within(dialog).getByLabelText('Name'), 'Scout');
    await user.type(within(dialog).getByLabelText('What is this Bot for?'), 'Watch the builds.');
    expect(within(dialog).getByLabelText('Host')).toHaveValue('host-mac');
    expect(within(dialog).getByLabelText('Agent')).toHaveValue('claude');
    await user.click(within(dialog).getByRole('button', { name: 'Add Bot' }));
    expect(await within(dialog).findByText("There's a Bot called Scout already.")).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'Watcher');
    await user.click(within(dialog).getByRole('button', { name: 'Add Bot' }));
    expect(await screen.findByRole('region', { name: 'Bot Watcher' })).toBeInTheDocument();
    await act(async () => {});
    expect(botRow('Watcher')).toHaveAttribute('aria-current', 'page');
  });
});
