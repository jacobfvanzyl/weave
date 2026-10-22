import { describe, expect, it } from 'vitest';
import type { RequestPermissionRequest, SessionUpdate } from '@/host/protocol';
import {
  type AcpTranscriptEvent,
  allSubagents,
  createTranscript,
  findSubagent,
  queueOptimisticPrompt,
  reduceAcpEvent,
  reduceJournalEvent,
  waitsForAnswer,
} from './acp-transcript';

describe('journal times', () => {
  const tool = (toolCallId: string, status: 'in_progress' | 'completed'): AcpTranscriptEvent =>
    ({ type: 'session/update', update: { sessionUpdate: 'tool_call_update', toolCallId, title: toolCallId, status } });
  const times = (transcript: ReturnType<typeof createTranscript>) =>
    transcript.entries.map(({ startedAt, updatedAt }) => [startedAt, updatedAt]);

  it('dates each entry by the events that made and last changed it', () => {
    let transcript = createTranscript('main');
    transcript = reduceJournalEvent(transcript, { type: 'prompt', prompt: [{ type: 'text', text: 'Go' }] }, 100);
    transcript = reduceJournalEvent(transcript, { type: 'session/update', update: { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'a', status: 'in_progress' } }, 200);
    transcript = reduceJournalEvent(transcript, { type: 'session/update', update: { sessionUpdate: 'tool_call', toolCallId: 'b', title: 'b', status: 'in_progress' } }, 300);
    transcript = reduceJournalEvent(transcript, tool('a', 'completed'), 400);
    expect(times(transcript)).toEqual([[100, 100], [200, 400], [300, 300]]);
    // Events that come without a time, as the app's own, date nothing.
    expect(times(reduceAcpEvent(transcript, tool('b', 'completed')))).toEqual([[100, 100], [200, 400], [300, 300]]);
  });

  it('keeps the dates of what follows this device\'s prompt when the Host\'s copy replaces it', () => {
    let transcript = createTranscript('main');
    transcript = queueOptimisticPrompt(transcript, 'local-1', [{ type: 'text', text: 'First' }]);
    transcript = reduceJournalEvent(transcript, { type: 'session/update', update: { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'a', status: 'in_progress' } }, 200);
    transcript = reduceJournalEvent(transcript, { type: 'prompt', prompt: [{ type: 'text', text: 'First' }], own: true }, 300);
    expect(transcript.entries.map(({ kind }) => kind)).toEqual(['tool', 'message']);
    expect(times(transcript)).toEqual([[200, 200], [300, 300]]);
  });

  it('dates a subagent\'s entries too', () => {
    let transcript = createTranscript('main');
    transcript = reduceJournalEvent(transcript, { type: 'session/update', update: { sessionUpdate: 'subagent_update', sessionId: 'main:ada', title: 'Ada' } }, 100);
    transcript = reduceJournalEvent(transcript, { type: 'session/update', sessionId: 'main:ada', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'On it.' } } }, 250);
    expect(times(transcript.subagents[0].transcript)).toEqual([[250, 250]]);
  });
});

describe('ACP transcript message reduction', () => {
  it('uses protocol message IDs as chunk boundaries', () => {
    const updates = [
      {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'thought-1',
        content: { type: 'text', text: 'Thinking ' },
      },
      {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'thought-1',
        content: { type: 'text', text: 'carefully' },
      },
      {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'thought-2',
        content: { type: 'text', text: 'A separate thought' },
      },
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'answer-1',
        content: { type: 'text', text: 'Answer ' },
      },
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'answer-1',
        content: { type: 'text', text: 'complete' },
      },
    ] satisfies SessionUpdate[];

    const model = updates.reduce(
      (current, update) => reduceAcpEvent(current, {
        type: 'session/update',
        update,
      }),
      createTranscript('session-1'),
    );

    expect(model.entries).toMatchObject([
      {
        kind: 'message',
        role: 'assistant',
        chunks: [
          {
            kind: 'thought',
            messageId: 'thought-1',
            content: [
              { type: 'text', text: 'Thinking ' },
              { type: 'text', text: 'carefully' },
            ],
          },
          {
            kind: 'thought',
            messageId: 'thought-2',
            content: [{ type: 'text', text: 'A separate thought' }],
          },
          {
            kind: 'message',
            messageId: 'answer-1',
            content: [
              { type: 'text', text: 'Answer ' },
              { type: 'text', text: 'complete' },
            ],
          },
        ],
      },
    ]);
  });

  it('replaces this device\'s optimistic prompt with the journaled one, whatever order its fields come in', () => {
    const sent = queueOptimisticPrompt(createTranscript('s'), 'local-1', [
      { type: 'text', text: 'What is this?' },
      { type: 'image', mimeType: 'image/jpeg', data: '/9j/AA==' },
    ]);
    const journaled = reduceAcpEvent(sent, {
      type: 'prompt',
      own: true,
      // As the Host writes it: the image's data before its type.
      prompt: JSON.parse('[{"type":"text","text":"What is this?"},{"type":"image","data":"/9j/AA==","mimeType":"image/jpeg"}]'),
    });
    expect(journaled.entries).toHaveLength(1);
    expect(journaled.entries[0]).toMatchObject({ kind: 'message', role: 'user', optimistic: false });
  });

  it('replaces the oldest optimistic prompt when the journaled one reads differently', () => {
    const sent = queueOptimisticPrompt(createTranscript('s'), 'local-1', [{ type: 'text', text: 'First' }]);
    const journaled = reduceAcpEvent(sent, { type: 'prompt', own: true, prompt: [{ type: 'text', text: 'First, normalized' }] });
    expect(journaled.entries.map((entry) => entry.kind === 'message' && entry.optimistic)).toEqual([false]);
  });

  it('deduplicates only a matching optimistic prompt echo', () => {
    const optimistic = queueOptimisticPrompt(
      createTranscript('session-1'),
      'local-1',
      [{ type: 'text', text: 'Typed prompt' }],
    );

    const echoed = reduceAcpEvent(optimistic, {
      type: 'session/update',
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'user-1',
        content: { type: 'text', text: 'Typed prompt' },
      },
    });
    const unrelated = reduceAcpEvent(echoed, {
      type: 'session/update',
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'user-2',
        content: { type: 'text', text: 'Agent-originated user context' },
      },
    });

    expect(unrelated.entries).toMatchObject([
      {
        kind: 'message',
        role: 'user',
        optimistic: false,
        messageId: 'user-1',
        chunks: [{ content: [{ type: 'text', text: 'Typed prompt' }] }],
      },
      {
        kind: 'message',
        role: 'user',
        optimistic: false,
        messageId: 'user-2',
        chunks: [
          { content: [{ type: 'text', text: 'Agent-originated user context' }] },
        ],
      },
    ]);
  });

  it('acknowledges a matching optimistic prompt even after another entry arrives', () => {
    const optimistic = queueOptimisticPrompt(
      createTranscript('session-1'),
      'local-1',
      [{ type: 'text', text: 'Typed prompt' }],
    );
    const interleaved = reduceAcpEvent(optimistic, {
      type: 'protocol/unknown',
      method: 'session/update',
      payload: { update: { sessionUpdate: '_vendor_progress' } },
    });

    const acknowledged = reduceAcpEvent(interleaved, {
      type: 'session/update',
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'user-1',
        content: { type: 'text', text: 'Typed prompt' },
      },
    });

    expect(acknowledged.entries).toHaveLength(2);
    expect(acknowledged.entries[0]).toMatchObject({
      kind: 'message',
      role: 'user',
      messageId: 'user-1',
      optimistic: false,
    });
  });

  it.each(['end_turn', 'cancelled'] as const)(
    'settles and retains an optimistic prompt when a turn stops with %s',
    (stopReason) => {
      const optimistic = queueOptimisticPrompt(
        createTranscript('session-1'),
        'local-1',
        [{ type: 'text', text: 'Keep this prompt' }],
      );

      const stopped = reduceAcpEvent(optimistic, {
        type: 'turn/stopped',
        stopReason,
      });

      expect(stopped.entries).toMatchObject([{
        kind: 'message',
        role: 'user',
        optimistic: false,
        chunks: [{ content: [{ type: 'text', text: 'Keep this prompt' }] }],
      }]);
      expect(stopped.turn).toEqual({ status: 'stopped', stopReason });
    },
  );

  it('settles and retains an optimistic prompt when a turn fails', () => {
    const failed = reduceAcpEvent(
      queueOptimisticPrompt(
        createTranscript('session-1'),
        'local-1',
        [{ type: 'text', text: 'Keep failed prompt' }],
      ),
      { type: 'turn/failed', error: 'Agent stopped.' },
    );

    expect(failed.entries).toMatchObject([{
      kind: 'message',
      optimistic: false,
      chunks: [{ content: [{ type: 'text', text: 'Keep failed prompt' }] }],
    }]);
  });
});

describe('ACP transcript structured updates', () => {
  it('upserts tool calls, preserves rich content, and surfaces update-before-create', () => {
    const created = reduceAcpEvent(createTranscript('session-1'), {
      type: 'session/update',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Inspect workspace',
        name: 'read_file',
        kind: 'read',
        status: 'in_progress',
        locations: [{ path: '/workspace/README.md', line: 3 }],
        content: [
          { type: 'content', content: { type: 'text', text: 'Reading' } },
          {
            type: 'diff',
            path: '/workspace/README.md',
            oldText: 'old',
            newText: 'new',
          },
          { type: 'terminal', terminalId: 'terminal-1' },
        ],
        rawInput: { path: '/workspace/README.md' },
      },
    });
    const completed = reduceAcpEvent(created, {
      type: 'session/update',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        title: 'Read workspace',
        status: 'completed',
        rawOutput: { lines: 12 },
      },
    });

    expect(completed.entries[0]).toMatchObject({
      kind: 'tool',
      toolCallId: 'tool-1',
      title: 'Read workspace',
      name: 'read_file',
      toolKind: 'read',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'Reading' } },
        { type: 'diff', path: '/workspace/README.md' },
        { type: 'terminal', terminalId: 'terminal-1' },
      ],
      locations: [{ path: '/workspace/README.md', line: 3 }],
      rawInput: { path: '/workspace/README.md' },
      rawOutput: { lines: 12 },
    });

    const missing = reduceAcpEvent(createTranscript('session-1'), {
      type: 'session/update',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'missing-tool',
        status: 'completed',
      },
    });
    expect(missing.entries[0]).toMatchObject({
      kind: 'tool',
      toolCallId: 'missing-tool',
      status: 'failed',
      title: 'Tool call not found',
    });
  });

  it('replaces the plan as the agent sends it again', () => {
    const updates = [
      { sessionUpdate: 'plan', entries: [{ content: 'Inspect code', priority: 'high', status: 'in_progress' }] },
      { sessionUpdate: 'plan', entries: [{ content: 'Run tests', priority: 'medium', status: 'pending' }] },
    ] satisfies SessionUpdate[];

    const model = updates.reduce(
      (current, update) => reduceAcpEvent(current, { type: 'session/update', update }),
      createTranscript('session-1'),
    );

    expect(model.entries.filter((entry) => entry.kind === 'plan')).toMatchObject([
      { planId: 'stable', format: 'entries', entries: [{ content: 'Run tests' }] },
    ]);
  });

  it('tracks commands, mode, configuration, session metadata, and cumulative usage', () => {
    let model = reduceAcpEvent(createTranscript('session-1'), {
      type: 'session/loaded',
      modes: {
        currentModeId: 'ask',
        availableModes: [
          { id: 'ask', name: 'Ask' },
          { id: 'code', name: 'Code' },
        ],
      },
      configOptions: [],
    });
    const updates = [
      {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'review', description: 'Review changes', input: { hint: 'path' } },
        ],
      },
      { sessionUpdate: 'current_mode_update', currentModeId: 'code' },
      {
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            type: 'boolean',
            id: 'fast',
            name: 'Fast mode',
            currentValue: true,
          },
        ],
      },
      {
        sessionUpdate: 'session_info_update',
        title: 'ACP transcript',
        updatedAt: '2026-08-24T12:00:00Z',
      },
      {
        sessionUpdate: 'usage_update',
        used: 1200,
        size: 10000,
        cost: { amount: 0.12, currency: 'USD' },
      },
      { sessionUpdate: 'usage_update', used: 1800, size: 10000 },
    ] satisfies SessionUpdate[];

    model = updates.reduce(
      (current, update) => reduceAcpEvent(current, {
        type: 'session/update',
        update,
      }),
      model,
    );

    expect(model).toMatchObject({
      title: 'ACP transcript',
      updatedAt: '2026-08-24T12:00:00Z',
      availableCommands: [{ name: 'review' }],
      currentModeId: 'code',
      availableModes: [{ id: 'ask' }, { id: 'code' }],
      configOptions: [{ id: 'fast', currentValue: true }],
      usage: {
        used: 1800,
        size: 10000,
        cost: { amount: 0.12, currency: 'USD' },
      },
    });
  });

  it('patches compactions in place and appends streamed summary content', () => {
    const updates = [
      {
        sessionUpdate: 'compaction_update',
        compactionId: 'compact-1',
        status: 'in_progress',
      },
      {
        sessionUpdate: 'compaction_summary_chunk',
        compactionId: 'compact-1',
        content: { type: 'text', text: 'Kept context' },
      },
      {
        sessionUpdate: 'compaction_update',
        compactionId: 'compact-1',
        status: 'completed',
      },
    ] as const;

    const model = updates.reduce(
      (current, update) => reduceAcpEvent(current, {
        type: 'session/update',
        update,
      }),
      createTranscript('session-1'),
    );

    expect(model.entries).toMatchObject([
      {
        kind: 'compaction',
        compactionId: 'compact-1',
        status: 'completed',
        summary: [{ type: 'text', text: 'Kept context' }],
      },
    ]);
  });
});

describe('ACP transcript client requests', () => {
  it('surfaces unknown protocol payloads without discarding their data', () => {
    const model = reduceAcpEvent(createTranscript('session-1'), {
      type: 'protocol/unknown',
      method: 'session/update',
      payload: {
        update: { sessionUpdate: '_vendor_progress', detail: { retained: true } },
      },
    });

    expect(model.entries[0]).toMatchObject({
      kind: 'diagnostic',
      severity: 'info',
      title: 'Unsupported ACP update',
      raw: {
        update: { sessionUpdate: '_vendor_progress', detail: { retained: true } },
      },
    });
  });

  it('keeps permission state attached to its tool through updates and resolution', () => {
    const requested = reduceAcpEvent(createTranscript('session-1'), {
      type: 'permission/requested',
      requestId: 'permission-1',
      request: {
        sessionId: 'session-1',
        toolCall: {
          toolCallId: 'tool-1',
          title: 'Run tests',
          kind: 'execute',
          status: 'pending',
        },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    const progressed = reduceAcpEvent(requested, {
      type: 'session/update',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'in_progress',
      },
    });
    const resolved = reduceAcpEvent(progressed, {
      type: 'permission/resolved',
      requestId: 'permission-1',
      optionId: 'allow',
    });

    expect(resolved.entries[0]).toMatchObject({
      kind: 'tool',
      status: 'in_progress',
      permission: {
        requestId: 'permission-1',
        status: 'answered',
        selectedOptionId: 'allow',
      },
    });
  });

  it('retains form, URL, and unknown elicitation requests and their lifecycle', () => {
    const form = reduceAcpEvent(createTranscript('session-1'), {
      type: 'elicitation/requested',
      requestId: 'elicit-form',
      request: {
        mode: 'form',
        sessionId: 'session-1',
        message: 'Configure the run',
        requestedSchema: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', title: 'Name' },
            retries: { type: 'integer', title: 'Retries' },
            ratio: { type: 'number', title: 'Ratio' },
            enabled: { type: 'boolean', title: 'Enabled' },
            tags: {
              type: 'array',
              title: 'Tags',
              items: { type: 'string', enum: ['ui', 'api'] },
            },
          },
        },
      },
    });
    const url = reduceAcpEvent(form, {
      type: 'elicitation/requested',
      requestId: 'elicit-url',
      request: {
        mode: 'url',
        sessionId: 'session-1',
        elicitationId: 'url-1',
        url: 'https://example.com/complete',
        message: 'Complete sign-in',
      },
    });
    const custom = reduceAcpEvent(url, {
      type: 'elicitation/requested',
      requestId: 'elicit-custom',
      request: {
        mode: '_vendor_challenge',
        sessionId: 'session-1',
        message: 'Complete custom challenge',
        _meta: { nonce: 'abc' },
      },
    });
    const accepted = reduceAcpEvent(custom, {
      type: 'elicitation/resolved',
      requestId: 'elicit-form',
      response: { action: 'accept', content: { name: 'Alpha' } },
    });
    const completed = reduceAcpEvent(accepted, {
      type: 'elicitation/completed',
      notification: { elicitationId: 'url-1' },
    });

    expect(completed.entries.filter((entry) => entry.kind === 'elicitation'))
      .toMatchObject([
        { requestId: 'elicit-form', request: { mode: 'form' }, status: 'answered', response: { action: 'accept' } },
        { requestId: 'elicit-url', request: { mode: 'url' }, status: 'completed' },
        {
          requestId: 'elicit-custom',
          request: { mode: '_vendor_challenge', _meta: { nonce: 'abc' } },
          status: 'pending',
        },
      ]);
  });
});

const permission = (toolCallId: string, sessionId = 'main'): RequestPermissionRequest => ({
  sessionId,
  toolCall: { toolCallId, title: `Write ${toolCallId}` },
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
  ],
});

const reduceAll = (...events: AcpTranscriptEvent[]) => events.reduce(reduceAcpEvent, createTranscript('main'));

describe('pending requests in the transcript', () => {
  it('ends a request as the Host says, keeping what this device chose', () => {
    const asked = reduceAll(
      { type: 'permission/requested', requestId: 'p-1', request: permission('t-1') },
      { type: 'permission/requested', requestId: 'p-2', request: permission('t-2') },
      { type: 'permission/requested', requestId: 'p-3', request: permission('t-3') },
      { type: 'permission/resolved', requestId: 'p-1', optionId: 'allow' },
      // The Host says this device answered: what it chose stays.
      { type: 'request/resolved', requestId: 'p-1', status: 'answered' },
      { type: 'request/resolved', requestId: 'p-2', status: 'elsewhere' },
      { type: 'request/resolved', requestId: 'p-3', status: 'withdrawn' },
    );
    expect(asked.entries.map((entry) => entry.kind === 'tool' && entry.permission)).toMatchObject([
      { status: 'answered', selectedOptionId: 'allow' },
      { status: 'elsewhere' },
      { status: 'withdrawn' },
    ]);
    expect(waitsForAnswer(asked)).toBe(false);
  });

  it('lets the Host overrule an answer shown before it was taken', () => {
    const lost = reduceAll(
      { type: 'permission/requested', requestId: 'p-1', request: permission('t-1') },
      { type: 'permission/resolved', requestId: 'p-1', optionId: 'allow' },
      { type: 'request/resolved', requestId: 'p-1', status: 'elsewhere' },
    );
    expect(lost.entries[0]).toMatchObject({ permission: { status: 'elsewhere' } });
  });

  it('shows a request again, once, after an answer that failed', () => {
    const again = reduceAll(
      { type: 'elicitation/requested', requestId: 'e-1', request: { mode: 'form', sessionId: 'main', message: 'Name?', requestedSchema: { type: 'object', properties: {} } } },
      { type: 'elicitation/resolved', requestId: 'e-1', response: { action: 'decline' } },
      { type: 'elicitation/requested', requestId: 'e-1', request: { mode: 'form', sessionId: 'main', message: 'Name?', requestedSchema: { type: 'object', properties: {} } } },
    );
    expect(again.entries).toHaveLength(1);
    expect(again.entries[0]).toMatchObject({ kind: 'elicitation', status: 'pending' });
    expect(again.entries[0]).not.toHaveProperty('response');
  });

  it('puts a subagent\'s request in its own transcript, and finds it there to answer', () => {
    const asked = reduceAll(
      { type: 'session/update', update: { sessionUpdate: 'subagent_update', sessionId: 'main:robie', title: 'Robie', state: { state: 'running' } } },
      { type: 'permission/requested', requestId: 'p-1', request: permission('t-1', 'main:robie'), sessionId: 'main:robie' },
    );
    expect(asked.entries.some((entry) => entry.kind === 'tool')).toBe(false);
    const robie = findSubagent(asked, 'main:robie')!;
    expect(waitsForAnswer(robie.transcript)).toBe(true);
    expect(allSubagents(asked).map(({ sessionId }) => sessionId)).toEqual(['main:robie']);

    const answered = reduceAcpEvent(asked, { type: 'permission/resolved', requestId: 'p-1', optionId: 'reject' });
    expect(findSubagent(answered, 'main:robie')!.transcript.entries[0]).toMatchObject({ permission: { status: 'answered', selectedOptionId: 'reject' } });
  });

  it('shows another client\'s client tool call until it answers', () => {
    const waiting = reduceAll({ type: 'clientTool/requested', requestId: 'c-1', tool: 'clipboard_write', runner: 'the TUI' });
    expect(waiting.entries[0]).toMatchObject({ kind: 'client-tool', tool: 'clipboard_write', runner: 'the TUI', status: 'pending' });
    // Nothing for this device to answer.
    expect(waitsForAnswer(waiting)).toBe(false);
    expect(reduceAcpEvent(waiting, { type: 'request/resolved', requestId: 'c-1', status: 'elsewhere' }).entries[0]).toMatchObject({ status: 'elsewhere' });
  });

  it('ends what no longer waits when settled on attaching, in subagents too', () => {
    const asked = reduceAll(
      { type: 'session/update', update: { sessionUpdate: 'subagent_update', sessionId: 'main:robie', title: 'Robie' } },
      { type: 'permission/requested', requestId: 'p-1', request: permission('t-1') },
      { type: 'permission/requested', requestId: 'p-2', request: permission('t-2') },
      { type: 'permission/requested', requestId: 'p-3', request: permission('t-3', 'main:robie'), sessionId: 'main:robie' },
      { type: 'permission/resolved', requestId: 'p-2', optionId: 'allow' },
    );
    const settled = reduceAcpEvent(asked, { type: 'requests/settled', waiting: ['p-1'] });
    expect(settled.entries.flatMap((entry) => entry.kind === 'tool' ? [entry.permission?.status] : [])).toEqual(['pending', 'answered']);
    expect(findSubagent(settled, 'main:robie')!.transcript.entries[0]).toMatchObject({ permission: { status: 'ended' } });
  });
});
