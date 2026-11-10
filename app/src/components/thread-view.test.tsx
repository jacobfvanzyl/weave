import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppActions, AppController, OpenThread, HostSummary } from '@/app/app-controller';
import { type AcpTranscriptEvent, createTranscript, reduceAcpEvent } from '@/chat/acp-transcript';
import { ThreadView, askThread } from './thread-view';

const actions = (): AppActions => ({
  selectThread: vi.fn(),
  createThread: vi.fn(),
  listDirectory: vi.fn(),
  listWorktrees: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  closeThread: vi.fn(),
  renameThread: vi.fn(),
  deleteThread: vi.fn(),
  pairDispatcher: vi.fn(),
  forgetDispatcher: vi.fn(),
  reconnectDispatcher: vi.fn(),
  reconnectHost: vi.fn(),
  send: vi.fn(),
  removeQueued: vi.fn(),
  resumeQueue: vi.fn(),
  cancelTurn: vi.fn(),
  reopenThread: vi.fn(),
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

const controller = (thread: OpenThread, handlers = actions(), host: Partial<HostSummary> = {}): AppController => ({
  model: {
    hosts: [{ id: 'h', name: 'mac', status: 'connected', canRename: true, ...host }],
    threads: [{
      key: thread.key, hostId: 'h', threadId: 'main', title: 'Count the files', agentId: 'claude', agentName: 'Claude',
      cwd: '/work/project', state: 'open', activity: 'idle', clients: 1, headless: false,
    }],
    agents: {},
    selectedKey: thread.key,
    thread,
    unread: new Set(),
  },
  actions: handlers,
});

const transcript = (...events: AcpTranscriptEvent[]) => events.reduce(reduceAcpEvent, createTranscript('main'));

describe('ThreadView', () => {
  beforeEach(() => localStorage.clear());

  it('says while its Host is away, and why when it stopped trying', () => {
    const thread: OpenThread = { key: 'h/main', transcript: createTranscript('main'), canSteer: true, queued: [] };
    const { rerender } = render(<ThreadView controller={controller(thread, actions(), { status: 'reconnecting' })} thread={thread} />);
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting to mac…');
    rerender(<ThreadView controller={controller(thread, actions(), { status: 'incompatible', error: 'This Host needs a newer version of the app.' })} thread={thread} />);
    expect(screen.getByRole('status')).toHaveTextContent("mac isn't connected. This Host needs a newer version of the app.");
    rerender(<ThreadView controller={controller(thread)} thread={thread} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('opens the thread one continues in', async () => {
    const user = userEvent.setup();
    const handlers = actions();
    const thread: OpenThread = { key: 'h/main', transcript: createTranscript('main'), canSteer: true, queued: [] };
    const continued = controller(thread, handlers);
    continued.model.threads[0] = { ...continued.model.threads[0], continuedIn: { key: 'h/next', label: '“Week 2”' } };
    render(<ThreadView controller={continued} thread={thread} />);
    expect(screen.getByText('This thread continues in “Week 2”')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(handlers.selectThread).toHaveBeenCalledWith('h/next');
  });

  it('updates an agent the Host hasn\'t updated, and moves the thread to it', async () => {
    const user = userEvent.setup();
    const handlers = actions();
    const thread: OpenThread = {
      key: 'h/main', transcript: createTranscript('main'), canSteer: true, queued: [],
      update: { agentId: 'claude', name: '@agentclientprotocol/claude-agent-acp', running: '0.86.0', latest: '0.94.0' },
    };
    const { rerender } = render(<ThreadView controller={controller(thread, handlers)} thread={thread} />);
    expect(screen.getByText('claude-agent-acp 0.94.0 is out; this thread runs 0.86.0.')).toBeInTheDocument();
    expect(screen.queryByText(/weave (agents )?update/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Move/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Update to 0.94.0' }));
    expect(handlers.updateAgent).toHaveBeenCalled();
    const updating = { ...thread, updating: true };
    rerender(<ThreadView controller={controller(updating, handlers)} thread={updating} />);
    expect(screen.getByRole('button', { name: 'Updating…' })).toBeDisabled();
  });

  it('keeps a dismissed update notice hidden in that thread, until there is more to say', async () => {
    const user = userEvent.setup();
    const update = { agentId: 'claude', name: '@agentclientprotocol/claude-agent-acp', running: '0.86.0', latest: '0.94.0' };
    const thread: OpenThread = { key: 'h/main', transcript: createTranscript('main'), canSteer: true, queued: [], update };
    const other: OpenThread = { ...thread, key: 'h/other' };
    const view = render(<ThreadView controller={controller(thread)} thread={thread} />);
    await user.click(screen.getByRole('button', { name: 'Dismiss update notice' }));
    expect(screen.queryByText(/is out/)).not.toBeInTheDocument();

    // Opened again, as after the app restarts.
    view.unmount();
    const { rerender } = render(<ThreadView controller={controller(thread)} thread={thread} />);
    expect(screen.queryByText(/is out/)).not.toBeInTheDocument();
    rerender(<ThreadView controller={controller(other)} thread={other} />);
    expect(screen.getByText(/0\.94\.0 is out/)).toBeInTheDocument();

    const movable = { ...thread, update: { ...update, available: '0.94.0' } };
    rerender(<ThreadView controller={controller(movable)} thread={movable} />);
    expect(screen.getByRole('button', { name: 'Move to 0.94.0' })).toBeInTheDocument();
    const newer = { ...thread, update: { ...update, latest: '0.95.0' } };
    rerender(<ThreadView controller={controller(newer)} thread={newer} />);
    expect(screen.getByText(/0\.95\.0 is out/)).toBeInTheDocument();
  });

  it('moves the thread once the Host launches the newer version', async () => {
    const user = userEvent.setup();
    const handlers = actions();
    const thread: OpenThread = {
      key: 'h/main', transcript: createTranscript('main'), canSteer: true, queued: [],
      update: { agentId: 'claude', name: '@agentclientprotocol/claude-agent-acp', running: '0.86.0', latest: '0.94.0', available: '0.94.0' },
    };
    const { rerender } = render(<ThreadView controller={controller(thread, handlers)} thread={thread} />);
    expect(screen.getByText(/The Host has 0.94.0 for new threads/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Move to 0.94.0' }));
    expect(handlers.reopenThread).toHaveBeenCalled();
    const moving = { ...thread, reopening: true };
    rerender(<ThreadView controller={controller(moving, handlers)} thread={moving} />);
    expect(screen.getByRole('button', { name: 'Moving…' })).toBeDisabled();
  });

  it('shows a subagent\'s own work, without a composer, and goes back to the thread', async () => {
    const user = userEvent.setup();
    const thread: OpenThread = {
      key: 'h/main',
      canSteer: true,
      queued: [],
      transcript: transcript(
        { type: 'session/update', update: { sessionUpdate: 'subagent_update', sessionId: 'main:robie', title: 'Robie', description: 'Counts files', state: { state: 'running' } } },
        { type: 'session/update', threadId: 'main:robie', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Counting now.' } } },
      ),
    };
    render(<ThreadView controller={controller(thread)} thread={thread} />);
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
    const ask = (requestId: string, threadId?: string): AcpTranscriptEvent => ({
      type: 'permission/requested',
      requestId,
      threadId,
      request: {
        sessionId: threadId ?? 'main',
        toolCall: { toolCallId: `tool-${requestId}`, title: `Write ${requestId}.txt` },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      },
    });
    const thread: OpenThread = {
      key: 'h/main',
      canSteer: true,
      queued: [],
      transcript: transcript(
        { type: 'session/update', update: { sessionUpdate: 'subagent_update', sessionId: 'main:robie', title: 'Robie', state: { state: 'requires_action' } } },
        ask('robie', 'main:robie'),
      ),
    };
    const { rerender } = render(<ThreadView controller={controller(thread)} thread={thread} />);
    expect(screen.getByText('Robie is waiting for you')).toBeInTheDocument();
    expect(screen.queryByText('Write robie.txt')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show Robie' }));
    expect(screen.getByText('Write robie.txt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(screen.queryByText('Robie is waiting for you')).not.toBeInTheDocument();

    // Main asks while Robie's work shows.
    const both = { ...thread, transcript: reduceAcpEvent(thread.transcript, ask('main')) };
    rerender(<ThreadView controller={controller(both)} thread={both} />);
    expect(screen.getByText('Main is waiting for you')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show Main' }));
    expect(screen.getByText('Write main.txt')).toBeInTheDocument();
    expect(screen.getByText('Robie is waiting for you')).toBeInTheDocument();
  });

  it('renames the thread through the Host, and says why it couldn\'t', async () => {
    const user = userEvent.setup();
    const handlers = actions();
    const thread: OpenThread = { key: 'h/main', transcript: createTranscript('main'), canSteer: true, queued: [] };
    render(<ThreadView controller={controller(thread, handlers)} thread={thread} />);
    await user.click(screen.getByRole('button', { name: 'Thread actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename thread…' }));
    const title = await screen.findByRole('textbox', { name: 'Title' });
    expect(title).toHaveValue('Count the files');
    await user.clear(title);
    await user.type(title, 'Count every file');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    expect(handlers.renameThread).toHaveBeenCalledWith('h/main', 'Count every file');
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument());

    vi.mocked(handlers.renameThread).mockRejectedValueOnce(new Error("Couldn't rename it: a title is at most 200 characters."));
    await user.click(screen.getByRole('button', { name: 'Thread actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename thread…' }));
    await user.click(await screen.findByRole('button', { name: 'Rename' }));
    expect(await screen.findByText("Couldn't rename it: a title is at most 200 characters.")).toBeInTheDocument();
  });

  it('has no header of its own in a Block, whose rail asks it for its status, a rename or its deletion', async () => {
    const user = userEvent.setup();
    const handlers = actions();
    const thread: OpenThread = { key: 'h/main', transcript: createTranscript('main'), canSteer: true, queued: [], mcpServers: [] };
    const opened = vi.fn();
    const deleted = vi.fn();
    const shown = controller(thread, handlers);
    shown.model.threads[0] = { ...shown.model.threads[0], activity: 'running', clients: 3, continuedIn: { key: 'h/next', label: 'Count again' } };
    render(<ThreadView controller={shown} thread={thread} chrome='block' onOpenThread={opened} onDeleted={deleted} />);
    // The Block's rail has its title, its mark and its menu: nothing of them here.
    expect(screen.queryByRole('heading', { name: 'Count the files' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Thread actions' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('2 other clients attached')).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="thread-header"]')).not.toBeInTheDocument();
    // The thread it continues in opens through the Session, which may be another.
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(opened).toHaveBeenCalledWith('h/next');
    expect(handlers.selectThread).not.toHaveBeenCalled();

    act(() => askThread('h/main', 'status'));
    expect(await screen.findByRole('dialog', { name: /status/i })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    // Another thread's Block asks nothing of this one.
    act(() => askThread('h/other', 'delete'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    act(() => askThread('h/main', 'delete'));
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete Count the files?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    expect(handlers.deleteThread).toHaveBeenCalledWith('h/main');
    expect(deleted).toHaveBeenCalled();
  });
});
