import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AppActions, AppController, OpenSession } from '@/app/app-controller';
import { type AcpTranscriptEvent, createTranscript, reduceAcpEvent } from '@/chat/acp-transcript';
import { SessionView } from './session-view';

const actions = (): AppActions => ({
  selectSession: vi.fn(),
  createSession: vi.fn(),
  closeSession: vi.fn(),
  deleteSession: vi.fn(),
  pairHost: vi.fn(),
  forgetHost: vi.fn(),
  reconnectHost: vi.fn(),
  send: vi.fn(),
  removeQueued: vi.fn(),
  cancelTurn: vi.fn(),
  reopenSession: vi.fn(),
  respondToPermission: vi.fn(),
  respondToElicitation: vi.fn(),
  setMode: vi.fn(),
  setConfigOption: vi.fn(),
});

const controller = (session: OpenSession, handlers = actions()): AppController => ({
  model: {
    hosts: [{ id: 'h', name: 'mac.example.ts.net', url: 'wss://mac.example.ts.net:7341', status: 'connected' }],
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
  it('says where to update an agent the Host hasn\'t updated, and offers no move yet', () => {
    const session: OpenSession = {
      key: 'h/main', transcript: createTranscript('main'), canSteer: true, queued: [],
      update: { agentId: 'claude', name: '@agentclientprotocol/claude-agent-acp', running: '0.86.0', latest: '0.94.0' },
    };
    render(<SessionView controller={controller(session)} session={session} />);
    expect(screen.getByText('claude-agent-acp 0.94.0 is out; this session runs 0.86.0.')).toBeInTheDocument();
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
    expect(screen.getByText(/The Host has 0.94.0 for new sessions/)).toBeInTheDocument();
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
});
