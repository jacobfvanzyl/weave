// @vitest-environment node
/// <reference types="bun" />
// Pending requests and client tools from the app against a real dev Host, reached through a dev
// Dispatcher it joined (`testing/dev-dispatcher.ts`), WVE-103: permissions, form and URL elicitations, the TUI answering first, requests already
// waiting on attaching, a subagent's request, and `clipboard_write` in the app's turns and the
// TUI's; and the thread list kept live (`threads/watch`, WVE-104) while the TUI drives a
// thread the app isn't in. Skipped unless the debug `weave` and fake agent are built.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppModel, type OpenThread, threadKey } from '@/app/app-controller';
import { waitingCount } from '@/app/thread-list';
import {
  type AcpTranscript,
  blocksText,
  findSubagent,
  type TranscriptEntry,
  type TranscriptToolCall,
} from '@/chat/acp-transcript';
import { clipboardWrite } from './client-tools';
import { HostConnection, type HostEvent } from './connection';
import type { HostStore } from './host-store';
import { HOST_PROTOCOL, type PendingRequest } from './protocol';
import { devStore, startDevDispatcher, type DevDispatcher } from './testing/dev-dispatcher';
import { devHostAvailable, startDevHost, unixConnector, type DevHost } from './testing/dev-host';

const waitFor = async <T,>(find: () => T | undefined | false, what: string, ms = 15_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await Bun.sleep(20);
  }
};

const line = (entry: TranscriptEntry) => {
  switch (entry.kind) {
    case 'message': {
      const text = blocksText(entry.chunks.filter(({ kind }) => kind === 'message').flatMap(({ content }) => content));
      return `${entry.role}: ${text}`;
    }
    case 'tool':
      return `tool ${entry.status}: ${entry.title}${entry.permission ? ` (permission ${entry.permission.status})` : ''}`;
    case 'elicitation':
      return `elicitation ${entry.status}: ${entry.request.message}`;
    case 'client-tool':
      return `client tool ${entry.tool} on ${entry.runner}: ${entry.status}`;
    default:
      return entry.kind === 'diagnostic' ? `${entry.severity}: ${entry.title}` : entry.kind;
  }
};

const last = <T,>(items: T[], matches: (item: T) => boolean): T | undefined => [...items].reverse().find(matches);

const permissionTool = (transcript: AcpTranscript, status = 'pending') =>
  last(transcript.entries, (entry) => entry.kind === 'tool' && entry.permission?.status === status) as TranscriptToolCall | undefined;

describe.skipIf(!devHostAvailable())('pending requests in the app with a dev Host', { timeout: 30_000 }, () => {
  let dispatcher: DevDispatcher;
  let host: DevHost;
  // The TUI: a local client that runs `clipboard_write` too.
  let tui: HostConnection;
  const tuiEvents: HostEvent[] = [];
  let store: HostStore;
  let hostId: string;
  const clipboard: string[] = [];

  const model = (): AppModel => store.snapshot();
  const thread = (): OpenThread => {
    const open = model().thread;
    if (!open) throw new Error('No thread is open.');
    return open;
  };
  const threadId = () => thread().key.slice(hostId.length + 1);
  const lines = () => thread().transcript.entries.map(line);
  const until = (what: string, done: (lines: string[], open: OpenThread) => boolean, ms?: number) =>
    waitFor(() => model().thread && done(lines(), thread()) ? lines() : undefined, what, ms)
      .catch((error: unknown) => { throw new Error(`${(error as Error).message}\n${lines().slice(-8).join('\n')}`); });
  const said = (text: string) => until(`the agent to say "${text}"`, (current) => current.includes(`assistant: ${text}`));
  /** The next request the TUI hears of, of `kind`. */
  const tuiHears = <K extends PendingRequest['kind']>(kind: K, after = tuiEvents.length) =>
    waitFor(() => tuiEvents.slice(after).flatMap((event) =>
      event.type === 'notification' && event.method === 'pending/added' && event.params.pending.kind === kind
        ? [event.params.pending as Extract<PendingRequest, { kind: K }>]
        : []).at(0), `the TUI to hear of a ${kind} request`);
  const tuiPrompts = (text: string) => tui.request('turn/start', { threadId: threadId(), prompt: [{ type: 'text', text }] });

  beforeAll(async () => {
    [dispatcher, host] = await Promise.all([startDevDispatcher(), startDevHost()]);
    await dispatcher.join(host, 'studio');
    tui = await HostConnection.connect({
      connector: unixConnector(host.socket),
      client: { name: 'weave-tui', version: '0' },
      capabilities: { clientTools: [HOST_PROTOCOL.clientTools.clipboardWrite] },
      credentials: { method: 'local' },
      onEvent: (event) => tuiEvents.push(event),
    });
    ({ store } = devStore({
      clientTools: { [HOST_PROTOCOL.clientTools.clipboardWrite]: clipboardWrite(async (text) => { clipboard.push(text); }) },
      deviceName: 'Test iPhone',
      schedule: (notify) => queueMicrotask(notify),
    }));
    await store.start();
    await store.actions.pairDispatcher({ url: dispatcher.url, code: await dispatcher.offer() });
    hostId = model().hosts[0].id;
    await store.actions.createThread({ hostId, cwd: host.cwd, agentId: 'fake' });
  }, 60_000);

  afterAll(async () => {
    store?.stop();
    tui?.close();
    await host?.stop();
    await dispatcher?.stop();
  });

  it('answers a permission request, and the thread waits on the person until then', async () => {
    const path = `${host.cwd}/notes.txt`;
    await store.actions.send(`/write ${path} hello`);
    const tool = await waitFor(() => permissionTool(thread().transcript), 'the permission request');
    expect(tool.title).toBe(`Write ${path}`);
    expect(tool.permission?.options.map((option) => option.name)).toEqual(['Allow', 'Reject']);
    const { key } = thread();
    await waitFor(() => model().threads.find((listed) => listed.key === key)?.activity === 'waiting', 'the thread to wait');

    await store.actions.respondToPermission(tool.permission!.requestId, 'allow');
    await said(`Wrote ${path}.`);
    expect(permissionTool(thread().transcript, 'answered')).toMatchObject({
      toolCallId: tool.toolCallId,
      status: 'completed',
      permission: { status: 'answered', selectedOptionId: 'allow' },
    });
    expect(model().error).toBeUndefined();
    expect(model().threadErrors).toBeUndefined();
  });

  it("shows what the agent tells the person outside the conversation until it's dismissed, and keeps it out of the transcript (WVE-230)", async () => {
    await store.actions.send('/notice');
    await said('I told you about the limit.');
    const { key } = thread();
    const [notice] = await waitFor(() => model().threadNotices?.[key], 'the notice');
    expect(notice).toMatchObject({ severity: 'warning', title: "You're near this week's limit", detail: 'It resets on Monday.' });
    expect(lines().some((entry) => entry.includes('limit') && !entry.startsWith('assistant:') && !entry.startsWith('user:'))).toBe(false);

    store.actions.dismissNotice?.(notice.id);
    expect(model().threadNotices).toBeUndefined();
  });

  it('closes the card and says so when the TUI answers first', async () => {
    await tui.request('thread/attach', { threadId: threadId() });
    const heard = tuiEvents.length;
    await store.actions.send(`/write ${host.cwd}/other.txt hi`);
    const tool = await waitFor(() => permissionTool(thread().transcript), 'the permission request');
    const pending = await tuiHears('permission', heard);
    expect(pending.id).toBe(tool.permission!.requestId);
    await tui.request('pending/answer', { threadId: threadId(), pendingId: pending.id, permission: { outcome: { outcome: 'selected', optionId: 'reject' } } });
    await said('Permission was not granted.');
    expect(lines()).toContain(`tool failed: Write ${host.cwd}/other.txt (permission elsewhere)`);

    // Too late from here: the card keeps saying who answered, and nothing is tried again.
    await store.actions.respondToPermission(pending.id, 'allow');
    expect(permissionTool(thread().transcript, 'elsewhere')?.permission?.status).toBe('elsewhere');
    expect(model().error).toBeUndefined();
    expect(model().threadErrors).toBeUndefined();
    await tui.request('thread/detach', { threadId: threadId() });
  });

  it('accepts a form elicitation with values, then declines one', async () => {
    const asked = (status: string) => last(thread().transcript.entries, (entry) => entry.kind === 'elicitation' && entry.status === status);
    await store.actions.send('/ask');
    const form = await waitFor(() => asked('pending'), 'the form');
    await store.actions.respondToElicitation(form.kind === 'elicitation' ? form.requestId : '', {
      action: 'accept',
      content: { name: 'Ada', age: 36, color: 'teal', subscribe: false },
    });
    await until('the thanks', (current) => current.some((entry) => entry.startsWith('assistant: Thanks! You told me:') && entry.includes('name=Ada') && entry.includes('age=36')));
    expect(asked('answered')).toMatchObject({ response: { action: 'accept' } });

    await store.actions.send('/ask');
    const second = await waitFor(() => asked('pending'), 'the second form');
    await store.actions.respondToElicitation(second.kind === 'elicitation' ? second.requestId : '', { action: 'decline' });
    await said('You declined to answer.');
  });

  it('leaves a URL elicitation waiting until the person consents, then hears its step finish', async () => {
    await store.actions.send('/connect');
    const card = await waitFor(() => last(thread().transcript.entries, (entry) => entry.kind === 'elicitation' && entry.status === 'pending'), 'the URL elicitation');
    await Bun.sleep(500);
    expect(lines()).not.toContain('assistant: Waiting for you to finish connecting… ');
    expect(lines().at(-1)).toBe('elicitation pending: Connect your Example account.');

    await store.actions.respondToElicitation(card.kind === 'elicitation' ? card.requestId : '', { action: 'accept' });
    await until('the step to finish', (current) => current.includes('elicitation completed: Connect your Example account.')
      && current.includes('assistant: Waiting for you to finish connecting… Connected.'));
  });

  it('says when the agent withdraws its request', async () => {
    await store.actions.send('/withdraw');
    await waitFor(() => permissionTool(thread().transcript), 'the permission request');
    await said('I withdrew that permission request.');
    expect(lines()).toContain('tool failed: Delete everything (permission withdrawn)');
  });

  it('says when cancelling the turn ends a request', async () => {
    await store.actions.send(`/write ${host.cwd}/never.txt no`);
    await waitFor(() => permissionTool(thread().transcript), 'the permission request');
    await store.actions.cancelTurn();
    await until('the request to end with the turn', (current) => current.includes(`tool failed: Write ${host.cwd}/never.txt (permission cancelled)`));
  });

  it('runs clipboard_write on this device in a turn the app started', async () => {
    await store.actions.send('/tool clipboard_write {"text": "from the agent"}');
    await said('clipboard_write answered: Copied to the clipboard.');
    expect(clipboard).toEqual(['from the agent']);
    // The agent's tool call shows it; there's nothing to wait on.
    expect(thread().transcript.entries.some(({ kind }) => kind === 'client-tool')).toBe(false);
  });

  it('leaves a client tool call in a turn the TUI started to the TUI', async () => {
    await tui.request('thread/attach', { threadId: threadId() });
    const heard = tuiEvents.length;
    await tuiPrompts('/tool clipboard_write {"text": "for the TUI"}');
    const call = await tuiHears('clientTool', heard);
    expect(call.target).toBe(tui.clientId);
    await until('the call to show as the TUI\'s', (current) => current.includes('client tool clipboard_write on the TUI: pending'));

    await tui.request('pending/answer', { threadId: threadId(), pendingId: call.id, clientTool: { content: [{ type: 'text', text: 'Copied on the Mac.' }] } });
    await until('the TUI\'s answer', (current) => current.includes('client tool clipboard_write on the TUI: elsewhere')
      && current.includes('assistant: clipboard_write answered: Copied on the Mac.'));
    expect(clipboard).toEqual(['from the agent']);
    await tui.request('thread/detach', { threadId: threadId() });
  });

  it('shows what waits on attaching, on its tool call after the history before it', async () => {
    const { key } = thread();
    const id = threadId();
    store.actions.selectThread(undefined);
    await tui.request('thread/attach', { threadId: id });
    const heard = tuiEvents.length;
    const path = `${host.cwd}/later.txt`;
    await tui.request('turn/start', { threadId: id, prompt: [{ type: 'text', text: `/write ${path} later` }] });
    const pending = await tuiHears('permission', heard);

    store.actions.selectThread(key);
    const tool = await waitFor(() => permissionTool(thread().transcript), 'the request on attaching');
    expect(tool.permission?.requestId).toBe(pending.id);
    const entries = thread().transcript.entries;
    const prompt = entries.findIndex((entry) => entry.kind === 'message' && line(entry) === `user: /write ${path} later`);
    expect(prompt).toBeGreaterThan(-1);
    expect(entries.indexOf(tool)).toBeGreaterThan(prompt);

    await store.actions.respondToPermission(pending.id, 'allow');
    await said(`Wrote ${path}.`);
    await tui.request('thread/detach', { threadId: id });
  });

  it('answers a subagent\'s permission request in its own transcript', async () => {
    await store.actions.send('/delegate');
    const robie = `${threadId()}:robie`;
    const tool = await waitFor(() => {
      const subagent = findSubagent(thread().transcript, robie);
      return subagent && permissionTool(subagent.transcript);
    }, 'Robie\'s permission request');
    expect(tool.title).toBe('Write count.txt');
    expect(permissionTool(thread().transcript)).toBeUndefined();

    await store.actions.respondToPermission(tool.permission!.requestId, 'allow');
    await said('Robie counted 12 files; Ada found nothing to fix.');
    expect(permissionTool(findSubagent(thread().transcript, robie)!.transcript, 'answered')).toMatchObject({ status: 'completed' });
  });

  it('keeps the list live while the TUI drives a thread the app isn\'t in, marking it while it waits', async () => {
    store.actions.selectThread(undefined);
    const listed = (key: string) => model().threads.find((listing) => listing.key === key);
    const { threadId } = await tui.request('thread/create', { agentId: 'fake', cwd: host.cwd });
    const key = threadKey(hostId, threadId);
    await Bun.sleep(300);
    // Nobody has prompted it: not listed.
    expect(listed(key)).toBeUndefined();

    const heard = tuiEvents.length;
    await tui.request('turn/start', { threadId, prompt: [{ type: 'text', text: `/write ${host.cwd}/watched.txt watched` }] });
    await waitFor(() => listed(key)?.activity === 'waiting', 'the waiting mark');
    expect(waitingCount(model().threads)).toBe(1);
    const pending = await tuiHears('permission', heard);
    await tui.request('pending/answer', { threadId, pendingId: pending.id, permission: { outcome: { outcome: 'selected', optionId: 'allow' } } });
    await waitFor(() => listed(key)?.activity === 'idle', 'the turn to end');
    expect(listed(key)?.title).toBeTruthy();
    // It finished while nobody here looked.
    expect(model().unread.has(key)).toBe(true);

    await tui.request('thread/close', { threadId });
    await waitFor(() => listed(key)?.state === 'closed', 'the thread to close');
    await tui.request('thread/delete', { threadId });
    await waitFor(() => !listed(key), 'the thread to go');
  });
});
