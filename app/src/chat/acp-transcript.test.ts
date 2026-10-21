import { describe, expect, it } from 'vitest';
import type { SessionUpdate } from '@/host/protocol';
import {
  createTranscript,
  queueOptimisticPrompt,
  reduceAcpEvent,
} from './acp-transcript';

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
        status: 'resolved',
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
        { requestId: 'elicit-form', request: { mode: 'form' }, status: 'accepted' },
        { requestId: 'elicit-url', request: { mode: 'url' }, status: 'completed' },
        {
          requestId: 'elicit-custom',
          request: { mode: '_vendor_challenge', _meta: { nonce: 'abc' } },
          status: 'pending',
        },
      ]);
  });
});
