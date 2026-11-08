import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppActions, AppController, OpenThread } from '@/app/app-controller';
import { type AcpTranscriptEvent, createTranscript, reduceAcpEvent } from '@/chat/acp-transcript';
import { AppShell } from '@/components/app-shell';
import { SurfaceApp } from './surface-app';
import type { SurfaceEnd, SurfaceLink, SurfaceStatus } from './surface-link';
import type { FromSurface, ToSurface } from './surface-messages';

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
  pairHost: vi.fn(),
  forgetHost: vi.fn(),
  renameHost: vi.fn(),
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

const controller = (thread: OpenThread | undefined, handlers: AppActions): AppController => ({
  model: {
    hosts: [{ id: 'h', name: 'mac.example.ts.net', url: 'wss://mac.example.ts.net:7341', status: 'connected' }],
    threads: [
      {
        key: 'h/main', hostId: 'h', threadId: 'main', title: 'Count the files', agentId: 'claude', agentName: 'Claude',
        cwd: '/work/project', state: 'open', activity: 'running', clients: 1, headless: false,
      },
      {
        key: 'h/other', hostId: 'h', threadId: 'other', title: 'Review the branch', agentId: 'codex', agentName: 'Codex',
        cwd: '/work/project', state: 'open', activity: 'waiting', clients: 1, headless: false,
      },
    ],
    agents: {},
    selectedKey: thread?.key,
    thread,
    unread: new Set(),
  },
  actions: handlers,
});

const transcript = (...events: AcpTranscriptEvent[]) => events.reduce(reduceAcpEvent, createTranscript('main'));
const reply = (text: string): AcpTranscriptEvent => ({
  type: 'session/update',
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
});
const ask: AcpTranscriptEvent = {
  type: 'permission/requested',
  requestId: 'write',
  request: {
    sessionId: 'main',
    toolCall: { toolCallId: 'tool-write', title: 'Write count.txt' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  },
};

/** The device's link and the Surface's end, joined in memory as the native relay joins them. */
function joined() {
  let status: SurfaceStatus = { available: true, enabled: true, connected: false };
  const statusListeners = new Set<(status: SurfaceStatus) => void>();
  const deviceListeners = new Set<(message: FromSurface) => void>();
  const surfaceListeners = new Set<(message: ToSurface) => void>();
  const toSurface: ToSurface[] = [];
  const setStatus = (next: Partial<SurfaceStatus>) => {
    status = { ...status, ...next };
    for (const listener of statusListeners) listener(status);
  };
  const link: SurfaceLink = {
    status: async () => status,
    onStatus: (listener) => { statusListeners.add(listener); return () => statusListeners.delete(listener); },
    onMessage: (listener) => { deviceListeners.add(listener); return () => deviceListeners.delete(listener); },
    send: (message) => {
      if (!status.connected) return;
      toSurface.push(message);
      for (const listener of surfaceListeners) listener(message);
    },
    setEnabled: vi.fn((enabled: boolean) => setStatus({ enabled, connected: enabled })),
    setLandscape: vi.fn(),
  };
  const end: SurfaceEnd = {
    onMessage: (listener) => { surfaceListeners.add(listener); return () => surfaceListeners.delete(listener); },
    send: (message) => {
      if (message.kind === 'ready') setStatus({ connected: status.enabled });
      for (const listener of deviceListeners) listener(message);
    },
  };
  return { link, end, toSurface };
}

describe('a Surface', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.dataset.deviceIdiom = 'phone';
  });
  afterEach(() => { delete document.documentElement.dataset.deviceIdiom; });

  it('shows the open thread while the iPhone keeps the composer, and dims it when the list is back', async () => {
    const { link, end } = joined();
    const handlers = actions();
    const thread: OpenThread = { key: 'h/main', transcript: transcript(reply('Counting the files now.')), canSteer: true, queued: [] };
    const phone = render(<AppShell controller={controller(thread, handlers)} surfaceLink={link} />);
    const surface = render(<SurfaceApp end={end} />);
    const onSurface = within(surface.container);
    const onPhone = within(phone.container);

    await waitFor(() => expect(onSurface.getByText('Counting the files now.')).toBeInTheDocument());
    expect(onSurface.getByRole('heading', { name: 'Count the files' })).toBeInTheDocument();
    expect(onSurface.getByText('1 thread needs you')).toBeInTheDocument();
    expect(onPhone.queryByText('Counting the files now.')).not.toBeInTheDocument();
    expect(onPhone.getByText('The thread is on your Surface.')).toBeInTheDocument();
    expect(onPhone.getByRole('textbox', { name: 'Message agent' })).toBeInTheDocument();
    expect(onPhone.getByRole('slider', { name: 'Scroll the Surface' })).toBeInTheDocument();
    expect(link.setLandscape).toHaveBeenLastCalledWith(true);

    // The reply goes on, and the Surface follows it.
    const streamed = { ...thread, transcript: reduceAcpEvent(thread.transcript, reply(' 42 so far.')) };
    phone.rerender(<AppShell controller={controller(streamed, handlers)} surfaceLink={link} />);
    await waitFor(() => expect(onSurface.getByText('Counting the files now. 42 so far.')).toBeInTheDocument());

    // Back to the list: the thread stays on the Surface, dimmed, and the iPhone stands up again.
    phone.rerender(<AppShell controller={controller(undefined, handlers)} surfaceLink={link} />);
    await waitFor(() => expect(surface.container.querySelector('[data-slot="surface"]')).toHaveAttribute('data-dimmed', 'true'));
    expect(onSurface.getByText('Counting the files now. 42 so far.')).toBeInTheDocument();
    expect(link.setLandscape).toHaveBeenLastCalledWith(false);
  });

  it('answers the thread\'s requests on the iPhone', async () => {
    const user = userEvent.setup();
    const { link, end } = joined();
    const handlers = actions();
    const thread: OpenThread = { key: 'h/main', transcript: transcript(ask), canSteer: true, queued: [] };
    const phone = render(<AppShell controller={controller(thread, handlers)} surfaceLink={link} />);
    render(<SurfaceApp end={end} />);
    const onPhone = within(phone.container);
    const request = await onPhone.findByRole('region', { name: 'Waiting for you' });
    expect(within(request).getByText('Write count.txt')).toBeInTheDocument();
    await user.click(within(request).getByRole('button', { name: 'Allow' }));
    expect(handlers.respondToPermission).toHaveBeenCalledWith('write', 'allow');
  });

  it('scrolls the Surface from the scrubber, and follows the end again from Latest', async () => {
    const user = userEvent.setup();
    const { link, end, toSurface } = joined();
    const thread: OpenThread = { key: 'h/main', transcript: transcript(reply('Counting.')), canSteer: true, queued: [] };
    const phone = render(<AppShell controller={controller(thread, actions())} surfaceLink={link} />);
    render(<SurfaceApp end={end} />);
    const onPhone = within(phone.container);
    const scrubber = await onPhone.findByRole('slider', { name: 'Scroll the Surface' });
    expect(onPhone.queryByRole('button', { name: 'Latest' })).not.toBeInTheDocument();

    // The Surface says it's scrolled up from the end.
    act(() => end.send({ kind: 'position', fraction: 0.5, following: false, scrollable: true }));
    expect(scrubber).toHaveAttribute('aria-valuenow', '50');
    scrubber.focus();
    await user.keyboard('{PageUp}');
    expect(toSurface).toContainEqual({ kind: 'scroll', fraction: 0.3 });
    await user.click(onPhone.getByRole('button', { name: 'Latest' }));
    expect(toSurface.at(-1)).toEqual({ kind: 'scroll', to: 'end' });
  });

  it('hands the display back when turned off, and the iPhone shows the thread again', async () => {
    const user = userEvent.setup();
    const { link, end } = joined();
    const thread: OpenThread = { key: 'h/main', transcript: transcript(reply('Counting the files now.')), canSteer: true, queued: [] };
    const phone = render(<AppShell controller={controller(thread, actions())} surfaceLink={link} />);
    render(<SurfaceApp end={end} />);
    const onPhone = within(phone.container);
    await onPhone.findByText('The thread is on your Surface.');
    await user.click(onPhone.getByRole('button', { name: 'Thread actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Turn the Surface off' }));
    expect(link.setEnabled).toHaveBeenCalledWith(false);
    await waitFor(() => expect(onPhone.getByText('Counting the files now.')).toBeInTheDocument());
    expect(link.setLandscape).toHaveBeenLastCalledWith(false);
    await user.click(onPhone.getByRole('button', { name: 'Thread actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Show on the Surface' })).toBeInTheDocument();
  });

  it('asks the device for everything again when it falls out of step', async () => {
    const sent: FromSurface[] = [];
    let deliver: (message: ToSurface) => void = () => {};
    const end: SurfaceEnd = {
      onMessage: (listener) => { deliver = listener; return () => {}; },
      send: (message) => sent.push(message),
    };
    render(<SurfaceApp end={end} />);
    expect(sent).toEqual([{ kind: 'ready' }]);
    act(() => deliver({ kind: 'show', thread: { key: 'h/main', title: 'Count the files' }, dimmed: false, waiting: 0 }));
    const { entries: _, ...base } = createTranscript('main');
    act(() => deliver({ kind: 'transcript', key: 'h/main', base, from: 3, entries: [], length: 3 }));
    await waitFor(() => expect(sent).toEqual([{ kind: 'ready' }, { kind: 'ready' }]));
  });
});
