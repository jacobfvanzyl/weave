import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AppActions, AppController, OpenSession, PairedHost } from '@/app/app-controller';
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
  respondToPermission: vi.fn(),
  respondToElicitation: vi.fn(),
  setMode: vi.fn(),
  setConfigOption: vi.fn(),
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
  it('says while its Host is away, and why when it stopped trying', () => {
    const session: OpenSession = { key: 'h/main', transcript: createTranscript('main'), canSteer: true, queued: [] };
    const { rerender } = render(<SessionView controller={controller(session, actions(), { status: 'reconnecting' })} session={session} />);
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting to mac.example.ts.net…');
    rerender(<SessionView controller={controller(session, actions(), { status: 'incompatible', error: 'This Host needs a newer version of the app.' })} session={session} />);
    expect(screen.getByRole('status')).toHaveTextContent("mac.example.ts.net isn't connected. This Host needs a newer version of the app.");
    rerender(<SessionView controller={controller(session)} session={session} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says where to update an agent the Host hasn\'t updated, and offers no move yet', () => {
    const session: OpenSession = {
      key: 'h/main', transcript: createTranscript('main'), canSteer: true, queued: [],
      update: { agentId: 'claude', name: '@agentclientprotocol/claude-agent-acp', running: '0.86.0', latest: '0.94.0' },
    };
    render(<SessionView controller={controller(session)} session={session} />);
    expect(screen.getByText('claude-agent-acp 0.94.0 is out; this thread runs 0.86.0.')).toBeInTheDocument();
    expect(screen.getByText('weave update claude')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Move/ })).not.toBeInTheDocument();
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
});
