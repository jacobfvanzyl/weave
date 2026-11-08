import { describe, expect, it } from 'vitest';
import type { AppModel, OpenThread, ThreadSummary } from '@/app/app-controller';
import { type AcpTranscriptEvent, createTranscript, reduceAcpEvent } from '@/chat/acp-transcript';
import { applyTranscript, showMessage, transcriptMessage, type ToSurface } from './surface-messages';

const chunk = (text: string): AcpTranscriptEvent => ({
  type: 'session/update',
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
});
const prompt = (text: string): AcpTranscriptEvent => ({
  type: 'session/update',
  update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } },
});
const transcript = (...events: AcpTranscriptEvent[]) => events.reduce(reduceAcpEvent, createTranscript('main'));

type TranscriptMessage = Extract<ToSurface, { kind: 'transcript' }>;

describe('transcript messages', () => {
  it('send every entry first, then only those from the first that changed', () => {
    const first = transcript(prompt('Count the files'), chunk('Counting'));
    const opening = transcriptMessage('h/main', first) as TranscriptMessage;
    expect(opening).toMatchObject({ from: 0, length: 2 });
    expect(opening.entries).toHaveLength(2);
    expect(opening).not.toHaveProperty('base.entries');

    // A streaming reply changes its last entry.
    const streamed = reduceAcpEvent(first, chunk(' now.'));
    const next = transcriptMessage('h/main', streamed, { key: 'h/main', transcript: first }) as TranscriptMessage;
    expect(next).toMatchObject({ from: 1, length: 2 });
    expect(next.entries).toEqual([streamed.entries[1]]);

    expect(transcriptMessage('h/main', streamed, { key: 'h/main', transcript: streamed })).toBeUndefined();
    // Another thread starts over.
    expect(transcriptMessage('h/other', streamed, { key: 'h/main', transcript: streamed })).toMatchObject({ from: 0, length: 2 });
  });

  it('bring the Surface to the device\'s transcript, or say it has to ask again', () => {
    const first = transcript(prompt('Count the files'), chunk('Counting'));
    const streamed = reduceAcpEvent(first, chunk(' now.'));
    const opened = applyTranscript(undefined, transcriptMessage('h/main', first) as TranscriptMessage);
    expect(opened?.transcript).toEqual(first);
    const next = applyTranscript(opened, transcriptMessage('h/main', streamed, { key: 'h/main', transcript: first }) as TranscriptMessage);
    expect(next?.transcript).toEqual(streamed);
    // A Surface that missed the opening can't take a change.
    expect(applyTranscript(undefined, transcriptMessage('h/main', streamed, { key: 'h/main', transcript: first }) as TranscriptMessage)).toBeUndefined();
  });
});

const summary = (key: string, activity: ThreadSummary['activity'], title?: string): ThreadSummary => ({
  key, hostId: 'h', threadId: key.slice(2), title, agentId: 'claude', agentName: 'Claude', cwd: '/work/project',
  git: { repo: '/work/project', worktree: '/work/project', branch: 'main' }, state: 'open', activity, clients: 1, headless: false,
});

const model = (thread?: OpenThread): AppModel => ({
  hosts: [{ id: 'h', name: 'mac', status: 'connected' }],
  threads: [summary('h/main', 'running', 'Count the files'), summary('h/other', 'waiting'), summary('h/third', 'waiting')],
  agents: {},
  selectedKey: thread?.key,
  thread,
  unread: new Set(),
});

describe('show messages', () => {
  it('show the open thread, and count the others that wait', () => {
    const thread: OpenThread = { key: 'h/main', transcript: createTranscript('main'), canSteer: true, queued: [] };
    expect(showMessage(model(thread), undefined)).toEqual({
      kind: 'show',
      thread: { key: 'h/main', title: 'Count the files', agentName: 'Claude', cwd: '/work/project', branch: 'main', activity: 'running' },
      dimmed: false,
      waiting: 2,
    });
  });

  it('dim the thread last open while the list is on the device', () => {
    expect(showMessage(model(), 'h/main')).toMatchObject({ thread: { key: 'h/main' }, dimmed: true, waiting: 2 });
    expect(showMessage(model(), undefined)).toEqual({ kind: 'show', dimmed: true, waiting: 2 });
  });

  it('say while the thread\'s history is still loading', () => {
    const thread: OpenThread = { key: 'h/main', transcript: createTranscript('main'), canSteer: true, queued: [], loading: true };
    expect(showMessage(model(thread), undefined).thread).toMatchObject({ loading: true });
  });
});
