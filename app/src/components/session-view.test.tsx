import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppActions, AppController, OpenSession, PairedHost, TerminalSummary } from '@/app/app-controller';
import { type AcpTranscriptEvent, createTranscript, reduceAcpEvent } from '@/chat/acp-transcript';
import { SessionView } from './session-view';

const actions = (): AppActions => ({
  selectSession: vi.fn(),
  createSession: vi.fn(),
  listDirectory: vi.fn(),
  listWorktrees: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  closeSession: vi.fn(),
  renameSession: vi.fn(),
  deleteSession: vi.fn(),
  pairHost: vi.fn(),
  forgetHost: vi.fn(),
  renameHost: vi.fn(),
  reconnectHost: vi.fn(),
  send: vi.fn(),
  removeQueued: vi.fn(),
  resumeQueue: vi.fn(),
  cancelTurn: vi.fn(),
  reopenSession: vi.fn(),
  updateAgent: vi.fn(),
  respondToPermission: vi.fn(),
  respondToElicitation: vi.fn(),
  setMode: vi.fn(),
  setConfigOption: vi.fn(),
  newTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  renameTerminal: vi.fn(),
  attachTerminal: vi.fn(),
});

const controller = (session: OpenSession, handlers = actions(), host: Partial<PairedHost> = {}): AppController => ({
  model: {
    hosts: [{ id: 'h', name: 'mac.example.ts.net', url: 'wss://mac.example.ts.net:7341', status: 'connected', canRename: true, ...host }],
    sessions: [{
      key: session.key, hostId: 'h', sessionId: 'main', title: 'Count the files', agentId: 'claude', agentName: 'Claude',
      cwd: '/work/project', state: 'open', activity: 'idle', clients: 1, headless: false,
    }],
    agents: {},
    selectedKey: session.key,
    session,
    unread: new Set(),
  },
  actions: handlers,
});

const transcript = (...events: AcpTranscriptEvent[]) => events.reduce(reduceAcpEvent, createTranscript('main'));

describe('SessionView', () => {
  beforeEach(() => localStorage.clear());

  it('says while its Host is away, and why when it stopped trying', () => {
    const session: OpenSession = { key: 'h/main', transcript: createTranscript('main'), canSteer: true, queued: [] };
    const { rerender } = render(<SessionView controller={controller(session, actions(), { status: 'reconnecting' })} session={session} />);
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting to mac.example.ts.net…');
    rerender(<SessionView controller={controller(session, actions(), { status: 'incompatible', error: 'This Host needs a newer version of the app.' })} session={session} />);
    expect(screen.getByRole('status')).toHaveTextContent("mac.example.ts.net isn't connected. This Host needs a newer version of the app.");
    rerender(<SessionView controller={controller(session)} session={session} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('updates an agent the Host hasn\'t updated, and moves the thread to it', async () => {
    const user = userEvent.setup();
    const handlers = actions();
    const session: OpenSession = {
      key: 'h/main', transcript: createTranscript('main'), canSteer: true, queued: [],
      update: { agentId: 'claude', name: '@agentclientprotocol/claude-agent-acp', running: '0.86.0', latest: '0.94.0' },
    };
    const { rerender } = render(<SessionView controller={controller(session, handlers)} session={session} />);
    expect(screen.getByText('claude-agent-acp 0.94.0 is out; this thread runs 0.86.0.')).toBeInTheDocument();
    expect(screen.queryByText(/weave update/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Move/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Update to 0.94.0' }));
    expect(handlers.updateAgent).toHaveBeenCalled();
    const updating = { ...session, updating: true };
    rerender(<SessionView controller={controller(updating, handlers)} session={updating} />);
    expect(screen.getByRole('button', { name: 'Updating…' })).toBeDisabled();
  });

  it('keeps a dismissed update notice hidden in that thread, until there is more to say', async () => {
    const user = userEvent.setup();
    const update = { agentId: 'claude', name: '@agentclientprotocol/claude-agent-acp', running: '0.86.0', latest: '0.94.0' };
    const session: OpenSession = { key: 'h/main', transcript: createTranscript('main'), canSteer: true, queued: [], update };
    const other: OpenSession = { ...session, key: 'h/other' };
    const view = render(<SessionView controller={controller(session)} session={session} />);
    await user.click(screen.getByRole('button', { name: 'Dismiss update notice' }));
    expect(screen.queryByText(/is out/)).not.toBeInTheDocument();

    // Opened again, as after the app restarts.
    view.unmount();
    const { rerender } = render(<SessionView controller={controller(session)} session={session} />);
    expect(screen.queryByText(/is out/)).not.toBeInTheDocument();
    rerender(<SessionView controller={controller(other)} session={other} />);
    expect(screen.getByText(/0\.94\.0 is out/)).toBeInTheDocument();

    const movable = { ...session, update: { ...update, available: '0.94.0' } };
    rerender(<SessionView controller={controller(movable)} session={movable} />);
    expect(screen.getByRole('button', { name: 'Move to 0.94.0' })).toBeInTheDocument();
    const newer = { ...session, update: { ...update, latest: '0.95.0' } };
    rerender(<SessionView controller={controller(newer)} session={newer} />);
    expect(screen.getByText(/0\.95\.0 is out/)).toBeInTheDocument();
  });

  it('moves the session once the Host launches the newer version', async () => {
    const user = userEvent.setup();
    const handlers = actions();
    const session: OpenSession = {
      key: 'h/main', transcript: createTranscript('main'), canSteer: true, queued: [],
      update: { agentId: 'claude', name: '@agentclientprotocol/claude-agent-acp', running: '0.86.0', latest: '0.94.0', available: '0.94.0' },
    };
    const { rerender } = render(<SessionView controller={controller(session, handlers)} session={session} />);
    expect(screen.getByText(/The Host has 0.94.0 for new threads/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Move to 0.94.0' }));
    expect(handlers.reopenSession).toHaveBeenCalled();
    const moving = { ...session, reopening: true };
    rerender(<SessionView controller={controller(moving, handlers)} session={moving} />);
    expect(screen.getByRole('button', { name: 'Moving…' })).toBeDisabled();
  });

  it('shows a subagent\'s own work, without a composer, and goes back to the session', async () => {
    const user = userEvent.setup();
    const session: OpenSession = {
      key: 'h/main',
      canSteer: true,
      queued: [],
      transcript: transcript(
        { type: 'session/update', update: { sessionUpdate: 'subagent_update', sessionId: 'main:robie', title: 'Robie', description: 'Counts files', state: { state: 'running' } } },
        { type: 'session/update', sessionId: 'main:robie', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Counting now.' } } },
      ),
    };
    render(<SessionView controller={controller(session)} session={session} />);
    expect(screen.queryByText('Counting now.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "Show Robie's work" }));
    expect(screen.getByText('Counting now.')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message agent' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Main' }));
    expect(screen.queryByText('Counting now.')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message agent' })).toBeInTheDocument();
  });

  it('says when a request waits in a transcript not on screen, and shows it', async () => {
    const user = userEvent.setup();
    const ask = (requestId: string, sessionId?: string): AcpTranscriptEvent => ({
      type: 'permission/requested',
      requestId,
      sessionId,
      request: {
        sessionId: sessionId ?? 'main',
        toolCall: { toolCallId: `tool-${requestId}`, title: `Write ${requestId}.txt` },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      },
    });
    const session: OpenSession = {
      key: 'h/main',
      canSteer: true,
      queued: [],
      transcript: transcript(
        { type: 'session/update', update: { sessionUpdate: 'subagent_update', sessionId: 'main:robie', title: 'Robie', state: { state: 'requires_action' } } },
        ask('robie', 'main:robie'),
      ),
    };
    const { rerender } = render(<SessionView controller={controller(session)} session={session} />);
    expect(screen.getByText('Robie is waiting for you')).toBeInTheDocument();
    expect(screen.queryByText('Write robie.txt')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show Robie' }));
    expect(screen.getByText('Write robie.txt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(screen.queryByText('Robie is waiting for you')).not.toBeInTheDocument();

    // Main asks while Robie's work shows.
    const both = { ...session, transcript: reduceAcpEvent(session.transcript, ask('main')) };
    rerender(<SessionView controller={controller(both)} session={both} />);
    expect(screen.getByText('Main is waiting for you')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show Main' }));
    expect(screen.getByText('Write main.txt')).toBeInTheDocument();
    expect(screen.getByText('Robie is waiting for you')).toBeInTheDocument();
  });

  it('renames the session through the Host, and says why it couldn\'t', async () => {
    const user = userEvent.setup();
    const handlers = actions();
    const session: OpenSession = { key: 'h/main', transcript: createTranscript('main'), canSteer: true, queued: [] };
    render(<SessionView controller={controller(session, handlers)} session={session} />);
    await user.click(screen.getByRole('button', { name: 'Thread actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename thread…' }));
    const title = await screen.findByRole('textbox', { name: 'Title' });
    expect(title).toHaveValue('Count the files');
    await user.clear(title);
    await user.type(title, 'Count every file');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    expect(handlers.renameSession).toHaveBeenCalledWith('h/main', 'Count every file');
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument());

    vi.mocked(handlers.renameSession).mockRejectedValueOnce(new Error("Couldn't rename it: a title is at most 200 characters."));
    await user.click(screen.getByRole('button', { name: 'Thread actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename thread…' }));
    await user.click(await screen.findByRole('button', { name: 'Rename' }));
    expect(await screen.findByText("Couldn't rename it: a title is at most 200 characters.")).toBeInTheDocument();
  });

  describe('terminals', () => {
    const size = { cols: 80, rows: 24 };
    const worktree: TerminalSummary[] = [
      { id: 't-mine', scope: '/work/project', openedFrom: 'main', label: 'tests', size, startedAt: 1 },
      { id: 't-other', scope: '/work/project', openedFrom: 'other', title: 'nvim', size, startedAt: 2 },
    ];
    const opened = (key: string, terminals = worktree): OpenSession => ({ key, transcript: createTranscript('main'), canSteer: true, queued: [], terminals });
    const tabNames = () => within(screen.getByRole('tablist', { name: 'Terminals' })).getAllByRole('tab').map((tab) => tab.textContent);

    afterEach(() => { delete document.documentElement.dataset.deviceIdiom; });

    it("shows a tab for each of the worktree's terminals, the newest it opened in front, as this device left it", async () => {
      const user = userEvent.setup();
      const handlers = actions();
      vi.mocked(handlers.newTerminal).mockResolvedValue('t-new');
      vi.mocked(handlers.closeTerminal).mockResolvedValue();
      const view = (open: OpenSession) => {
        const given = controller(open, handlers, { canTerminals: true });
        given.model.sessions[0].sessionId = open.key.slice(2);
        return <SessionView controller={given} session={open} />;
      };
      const selected = () => within(screen.getByRole('tablist', { name: 'Terminals' })).getByRole('tab', { selected: true });
      const { rerender } = render(view(opened('h/main')));
      expect(screen.queryByRole('region', { name: 'Terminals' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Show terminals, 2 open' }));
      expect(tabNames()).toEqual(['tests', 'nvim']);
      expect(selected()).toHaveTextContent('tests');

      // Another thread of the worktree has the same tabs, its own in front.
      rerender(view(opened('h/other')));
      await user.click(screen.getByRole('button', { name: 'Show terminals, 2 open' }));
      expect(tabNames()).toEqual(['tests', 'nvim']);
      expect(selected()).toHaveTextContent('nvim');
      await user.click(screen.getByRole('tab', { name: /tests/ }));

      // A terminal made from a thread, on any device, is a tab in every thread of the worktree.
      rerender(view(opened('h/main')));
      await user.click(screen.getByRole('button', { name: 'New terminal' }));
      expect(handlers.newTerminal).toHaveBeenCalled();
      const made: TerminalSummary = { id: 't-new', scope: '/work/project', openedFrom: 'main', size, startedAt: 3 };
      rerender(view(opened('h/main', [...worktree, made])));
      expect(tabNames()).toEqual(['tests', 'nvim', 'project']);
      expect(selected()).toHaveTextContent('project');
      rerender(view(opened('h/other', [...worktree, made])));
      expect(tabNames()).toEqual(['tests', 'nvim', 'project']);
      expect(selected()).toHaveTextContent('tests');

      // Closing its tab ends it, once confirmed, and the Host's word closes the tab everywhere.
      await user.click(screen.getByRole('button', { name: 'Close tests' }));
      await user.click(await screen.findByRole('button', { name: 'Close terminal' }));
      expect(handlers.closeTerminal).toHaveBeenCalledWith('t-mine');
      rerender(view(opened('h/other', [worktree[1], made])));
      expect(tabNames()).toEqual(['nvim', 'project']);
      expect(selected()).toHaveTextContent('nvim');

      await user.click(screen.getByRole('button', { name: 'Hide terminals' }));
      expect(screen.queryByRole('region', { name: 'Terminals' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Show terminals, 2 open' })).toBeInTheDocument();
    });

    it('starts a terminal when it opens on none, and closes with the last, wherever that ended', async () => {
      const user = userEvent.setup();
      const handlers = actions();
      let start: (id: string) => void = () => {};
      vi.mocked(handlers.newTerminal).mockImplementation(() => new Promise((resolve) => { start = resolve; }));
      const view = (terminals: TerminalSummary[]) => {
        const open = opened('h/main', terminals);
        return <SessionView controller={controller(open, handlers, { canTerminals: true })} session={open} />;
      };
      const { rerender } = render(view([]));
      await user.click(screen.getByRole('button', { name: 'Show terminals' }));
      expect(handlers.newTerminal).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Starting a terminal…')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();

      // It stays open while the Host lists the new terminal, then shows it.
      start('t-new');
      await waitFor(() => expect(screen.getByText('Starting a terminal…')).toBeInTheDocument());
      const made: TerminalSummary = { id: 't-new', scope: '/work/project', openedFrom: 'main', size, startedAt: 3 };
      rerender(view([made]));
      expect(tabNames()).toEqual(['project']);

      // Another terminal opens and ends; the pane stays while one is left, and goes with the last.
      rerender(view([made, worktree[1]]));
      rerender(view([worktree[1]]));
      expect(tabNames()).toEqual(['nvim']);
      rerender(view([]));
      expect(screen.queryByRole('region', { name: 'Terminals' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Show terminals' })).toBeInTheDocument();
    });

    it("says why a terminal didn't start, and tries again", async () => {
      const user = userEvent.setup();
      const handlers = actions();
      vi.mocked(handlers.newTerminal).mockRejectedValueOnce(new Error("Couldn't start a terminal: no shell")).mockResolvedValueOnce('t-new');
      const session = opened('h/main', []);
      render(<SessionView controller={controller(session, handlers, { canTerminals: true })} session={session} />);
      await user.click(screen.getByRole('button', { name: 'Show terminals' }));
      expect(await screen.findByText("Couldn't start a terminal: no shell")).toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Terminals' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      expect(handlers.newTerminal).toHaveBeenCalledTimes(2);
      expect(screen.getByText('Starting a terminal…')).toBeInTheDocument();
    });

    it("shares the thread's top rail on the iPad, and takes it over the thread's width", async () => {
      const user = userEvent.setup();
      const session = opened('h/main');
      render(<SessionView controller={controller(session, actions(), { canTerminals: true })} session={session} leading={<button type='button'>Show threads</button>} />);
      await user.click(screen.getByRole('button', { name: 'Show terminals, 2 open' }));
      const header = document.querySelector('[data-slot="session-header"]') as HTMLElement;
      expect(within(header).getByRole('button', { name: 'Hide terminals' })).toBeInTheDocument();
      expect(document.querySelector('[data-slot="terminal-rail"]')).toContainElement(screen.getByRole('tablist', { name: 'Terminals' }));

      await user.click(screen.getByRole('button', { name: 'Terminal actions' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Full width' }));
      // The thread's header gives way, and its controls come to the terminals' rail.
      expect(document.querySelector('[data-slot="session-header"]')).not.toBeInTheDocument();
      const rail = document.querySelector('[data-slot="terminal-rail"]') as HTMLElement;
      expect(within(rail).getByRole('button', { name: 'Show threads' })).toBeInTheDocument();
      await user.click(within(rail).getByRole('button', { name: 'Hide terminals' }));
      expect(screen.queryByRole('region', { name: 'Terminals' })).not.toBeInTheDocument();
      expect(document.querySelector('[data-slot="session-header"]')).toBeInTheDocument();
    });

    it("drags the pane's edge as the sidebar's, keeping the pane's width, and the thread fits the rest", async () => {
      const user = userEvent.setup();
      const session = opened('h/main');
      render(<SessionView controller={controller(session, actions(), { canTerminals: true })} session={session} />);
      await user.click(screen.getByRole('button', { name: 'Show terminals, 2 open' }));
      // The thread runs from the sidebar's edge to the window's.
      const view = screen.getByRole('region', { name: 'Count the files' });
      vi.spyOn(view, 'getBoundingClientRect').mockReturnValue({ left: 256, right: 1180, width: 924, top: 0, bottom: 800, height: 800, x: 256, y: 0, toJSON: () => ({}) });
      const edge = () => screen.getByRole('separator', { name: 'Resize terminals' });
      const side = () => document.querySelector('[data-slot="terminal-side"]') as HTMLElement;
      expect(edge()).toHaveAttribute('aria-valuenow', '440');

      fireEvent.pointerDown(edge(), { clientX: 740 });
      fireEvent.pointerMove(edge(), { clientX: 680 });
      expect(edge()).toHaveAttribute('aria-valuenow', '500');
      expect(side().style.getPropertyValue('--terminal-pane-width')).toBe('500px');
      // No narrower than its least, and the thread keeps its own.
      fireEvent.pointerMove(edge(), { clientX: 1000 });
      expect(edge()).toHaveAttribute('aria-valuenow', '280');
      fireEvent.pointerMove(edge(), { clientX: 300 });
      expect(edge()).toHaveAttribute('aria-valuenow', '604');
      fireEvent.pointerMove(edge(), { clientX: 680 });
      fireEvent.pointerUp(edge());
      expect(JSON.parse(localStorage.getItem('weave.terminalLayout') ?? '{}').width).toBe(500);

      edge().focus();
      await user.keyboard('{ArrowLeft}');
      expect(edge()).toHaveAttribute('aria-valuenow', '516');
      await user.dblClick(edge());
      expect(edge()).toHaveAttribute('aria-valuenow', '440');

      // Over the thread's width there's no edge to drag.
      await user.click(screen.getByRole('button', { name: 'Terminal actions' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Full width' }));
      expect(screen.queryByRole('separator', { name: 'Resize terminals' })).not.toBeInTheDocument();
    });

    it("swaps the chat for the terminals under the thread's header on the iPhone", async () => {
      document.documentElement.dataset.deviceIdiom = 'phone';
      const user = userEvent.setup();
      const session = opened('h/main');
      render(<SessionView controller={controller(session, actions(), { canTerminals: true })} session={session} />);
      const header = document.querySelector('[data-slot="session-header"]') as HTMLElement;
      await user.click(within(header).getByRole('button', { name: 'Show terminals, 2 open' }));
      expect(screen.getByRole('region', { name: 'Terminals' })).toBeInTheDocument();
      expect(document.querySelector('[data-slot="terminal-bar"]')).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /message/i }).closest('.hidden')).not.toBeNull();
      await user.click(screen.getByRole('button', { name: 'Terminal actions' }));
      expect(screen.queryByRole('menuitem', { name: 'Full width' })).not.toBeInTheDocument();
      await user.keyboard('{Escape}');
      // The same button, in the same place, swaps back.
      await user.click(within(header).getByRole('button', { name: 'Hide terminals' }));
      expect(screen.queryByRole('region', { name: 'Terminals' })).not.toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /message/i }).closest('.hidden')).toBeNull();
    });

    it('offers none on a Host without terminals', () => {
      const session = opened('h/main');
      render(<SessionView controller={controller(session)} session={session} />);
      expect(screen.queryByRole('button', { name: /terminals/ })).not.toBeInTheDocument();
    });
  });
});
