import type {
  ContentBlock,
  SessionUpdate,
  ToolKind,
} from '@/host/protocol';
import {
  createTranscript,
  reduceAcpEvent,
  reduceJournalEvent,
  type AcpTranscript,
  type AcpTranscriptEvent,
} from './acp-transcript';
import markdownRecording from './fixtures/journals/markdown.json';

export const ACP_SESSION_UPDATE_KINDS = [
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
  'compaction_update',
  'compaction_summary_chunk',
  'subagent_update',
  'session_message',
  'session_message_chunk',
  'notice',
] as const satisfies readonly SessionUpdate['sessionUpdate'][];

export const ACP_CONTENT_BLOCK_KINDS = [
  'text',
  'image',
  'audio',
  'resource_link',
  'resource',
] as const satisfies readonly ContentBlock['type'][];

export const ACP_TOOL_KINDS = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
] as const satisfies readonly ToolKind[];

const sessionUpdateCoverage: Exclude<
  SessionUpdate['sessionUpdate'],
  typeof ACP_SESSION_UPDATE_KINDS[number]
> extends never ? true : never = true;
const contentBlockCoverage: Exclude<
  ContentBlock['type'],
  typeof ACP_CONTENT_BLOCK_KINDS[number]
> extends never ? true : never = true;
const toolKindCoverage: Exclude<
  ToolKind,
  typeof ACP_TOOL_KINDS[number]
> extends never ? true : never = true;
void sessionUpdateCoverage;
void contentBlockCoverage;
void toolKindCoverage;

const events: AcpTranscriptEvent[] = [
  {
    type: 'session/update',
    update: {
      sessionUpdate: 'user_message_chunk',
      messageId: 'user-showcase',
      content: { type: 'text', text: 'Exercise the complete ACP renderer.' },
    },
  },
  {
    type: 'session/update',
    update: {
      sessionUpdate: 'agent_thought_chunk',
      messageId: 'thought-showcase',
      content: { type: 'text', text: 'Checking every content family.' },
    },
  },
  ...([
    { type: 'text', text: '## ACP rich content\n\nStreaming **Markdown** is active.' },
    {
      type: 'image',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      mimeType: 'image/png',
      uri: 'memory://pixel.png',
    },
    { type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav' },
    {
      type: 'resource_link',
      name: 'Protocol reference',
      title: 'ACP specification',
      description: 'Linked resource metadata',
      uri: 'https://agentclientprotocol.com',
      mimeType: 'text/html',
      size: 2048,
    },
    {
      type: 'resource',
      resource: {
        uri: 'file:///workspace/README.md',
        mimeType: 'text/markdown',
        text: '# Embedded README',
      },
    },
    {
      type: 'resource',
      resource: {
        uri: 'memory://archive.bin',
        mimeType: 'application/octet-stream',
        blob: 'AAEC',
      },
    },
  ] satisfies ContentBlock[]).map((content) => ({
    type: 'session/update' as const,
    update: {
      sessionUpdate: 'agent_message_chunk' as const,
      messageId: 'agent-showcase',
      content,
    },
  })),
  {
    type: 'session/update',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-showcase',
      title: 'Update README',
      name: 'edit_file',
      kind: 'edit',
      status: 'in_progress',
      locations: [{ path: '/workspace/README.md', line: 1 }],
      rawInput: { path: '/workspace/README.md' },
      content: [
        { type: 'content', content: { type: 'text', text: 'Preparing edit' } },
        {
          type: 'diff',
          path: '/workspace/README.md',
          oldText: '# Old',
          newText: '# New',
        },
        { type: 'terminal', terminalId: 'terminal-showcase' },
      ],
    },
  },
  { type: 'terminal/output', terminalId: 'terminal-showcase', data: '\u001b[32mok\u001b[0m README updated\n' },
  { type: 'terminal/exit', terminalId: 'terminal-showcase', status: { exitCode: 0 } },
  {
    type: 'session/update',
    update: {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Inspect the protocol', priority: 'high', status: 'completed' },
        { content: 'Render every block', priority: 'medium', status: 'in_progress' },
        { content: 'Run acceptance', priority: 'low', status: 'pending' },
      ],
    },
  },
  {
    type: 'session/update',
    update: {
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'review', description: 'Review the current change', input: { hint: 'path' } },
      ],
    },
  },
  {
    type: 'session/update',
    update: { sessionUpdate: 'current_mode_update', currentModeId: 'code' },
  },
  {
    type: 'session/update',
    update: {
      sessionUpdate: 'config_option_update',
      configOptions: [
        {
          type: 'select',
          id: 'model',
          name: 'Model',
          category: 'model',
          currentValue: 'gpt',
          options: [{ value: 'gpt', name: 'GPT' }, { value: 'claude', name: 'Claude' }],
        },
        {
          type: 'boolean',
          id: 'fast',
          name: 'Fast mode',
          currentValue: true,
        },
      ],
    },
  },
  {
    type: 'session/update',
    update: {
      sessionUpdate: 'session_info_update',
      title: 'Complete ACP showcase',
      updatedAt: '2026-08-24T12:00:00Z',
    },
  },
  {
    type: 'session/update',
    update: {
      sessionUpdate: 'usage_update',
      used: 4096,
      size: 32768,
      cost: { amount: 0.42, currency: 'USD' },
    },
  },
  {
    type: 'session/update',
    update: {
      sessionUpdate: 'compaction_update',
      compactionId: 'compaction-showcase',
      status: 'in_progress',
    },
  },
  {
    type: 'session/update',
    update: {
      sessionUpdate: 'notice',
      severity: 'warning',
      title: "You're near this week's limit",
      description: 'It resets on Monday.',
    },
  },
  {
    type: 'session/update',
    update: {
      sessionUpdate: 'compaction_summary_chunk',
      compactionId: 'compaction-showcase',
      content: { type: 'text', text: 'Earlier context was compacted safely.' },
    },
  },
  {
    type: 'session/update',
    update: {
      sessionUpdate: 'compaction_update',
      compactionId: 'compaction-showcase',
      status: 'completed',
    },
  },
  {
    type: 'permission/requested',
    requestId: 'permission-showcase',
    request: {
      sessionId: 'showcase',
      toolCall: {
        toolCallId: 'tool-showcase',
        title: 'Update README',
        status: 'in_progress',
      },
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        { optionId: 'never', name: 'Never allow', kind: 'reject_always' },
      ],
    },
  },
  {
    type: 'elicitation/requested',
    requestId: 'form-showcase',
    request: {
      mode: 'form',
      sessionId: 'showcase',
      message: 'Configure acceptance',
      requestedSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', title: 'Name', default: 'Weave' },
          email: { type: 'string', title: 'Email', format: 'email' },
          retries: { type: 'integer', title: 'Retries', default: 2 },
          ratio: { type: 'number', title: 'Ratio', default: 0.5 },
          enabled: { type: 'boolean', title: 'Enabled', default: true },
          tags: {
            type: 'array',
            title: 'Tags',
            items: { type: 'string', enum: ['ui', 'protocol'] },
            default: ['ui'],
          },
        },
      },
    },
  },
  {
    type: 'elicitation/requested',
    requestId: 'url-showcase',
    request: {
      mode: 'url',
      sessionId: 'showcase',
      elicitationId: 'url-showcase-id',
      url: 'https://example.com/authorize',
      message: 'Authorize in your browser',
    },
  },
  {
    type: 'elicitation/requested',
    requestId: 'custom-showcase',
    request: {
      mode: '_weave_custom',
      sessionId: 'showcase',
      message: 'Unsupported future interaction',
      _meta: { retained: true },
    },
  },
  {
    type: 'clientTool/requested',
    requestId: 'client-tool-showcase',
    tool: 'clipboard_write',
    runner: 'the TUI',
  },
  {
    type: 'protocol/unknown',
    method: 'session/update',
    payload: {
      sessionId: 'showcase',
      update: {
        sessionUpdate: '_vendor_progress',
        detail: { retained: true },
      },
    },
  },
  {
    type: 'prompt',
    prompt: [{ type: 'text', text: 'Delegate the file count.' }],
    origin: "Jaco's iPhone",
  },
  {
    type: 'session/update',
    update: {
      sessionUpdate: 'subagent_update',
      sessionId: 'showcase:robie',
      title: 'Robie',
      description: 'Counts the files under src/',
      state: { state: 'running' },
    },
  },
  {
    type: 'session/update',
    update: {
      sessionUpdate: 'session_message',
      messageId: 'to-robie',
      senderSessionId: 'showcase',
      recipientSessionId: 'showcase:robie',
      content: [{ type: 'text', text: 'Count the files under src/, please.' }],
    },
  },
  {
    type: 'session/update',
    threadId: 'showcase:robie',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'robie-read',
      title: 'Read src',
      kind: 'read',
      status: 'completed',
    },
  },
  {
    type: 'session/update',
    threadId: 'showcase:robie',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'There are 12 files.' } },
  },
  {
    type: 'session/update',
    update: {
      sessionUpdate: 'subagent_update',
      sessionId: 'showcase:robie',
      state: { state: 'idle', stopReason: 'end_turn' },
    },
  },
  { type: 'turn/ended', stopReason: 'cancelled' },
];

/** The showcase's turns, after what `earlier` holds. */
export const createAcpShowcaseTranscript = (earlier = createTranscript('showcase')): AcpTranscript =>
  structuredClone(events).reduce(reduceAcpEvent, earlier);

const said = (messageId: string, text: string): AcpTranscriptEvent =>
  ({ type: 'session/update', update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } }, replayed: true });

const called = (toolCallId: string, title: string, kind: ToolKind, status: 'completed' | 'in_progress' = 'completed'): AcpTranscriptEvent =>
  ({ type: 'session/update', update: { sessionUpdate: 'tool_call', toolCallId, title, kind, status } });

const prompted = (text: string, steer = false): AcpTranscriptEvent =>
  ({ type: 'prompt', prompt: [{ type: 'text', text }], ...(steer ? { steer } : {}), replayed: true });

/**
 * Three finished turns, dated as a journal dates them, from `start` on, for the mock scenarios
 * (WVE-218): one that worked through its commentary and tool calls for 2m 17s, one steered as it
 * ran, which continued for 40s after the steer, and one the person stopped after 1m 5s.
 */
export function createFinishedTurnsTranscript(threadId: string, start: number): AcpTranscript {
  const seconds = (at: number) => start + at * 1_000;
  const journal: [AcpTranscriptEvent, number][] = [
    [prompted('Find where the parser loads its fixtures, and point it at tests/fixtures.'), seconds(0)],
    [said('narrate-1', "I'll read the parser and find where it loads its fixtures."), seconds(4)],
    [called('narrate-read', 'Read src/parser.rs', 'read'), seconds(9)],
    [called('narrate-search', 'Search for "fixtures"', 'search'), seconds(21)],
    [said('narrate-2', "It reads them from the old path. I'll point it at tests/fixtures and run the tests."), seconds(38)],
    [called('narrate-edit', 'Edit src/parser.rs', 'edit'), seconds(52)],
    [called('narrate-test', 'Run cargo test -p parser', 'execute', 'in_progress'), seconds(60)],
    [{ type: 'session/update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'narrate-test', status: 'completed' } }, seconds(130)],
    [said('narrate-3', 'Done: the parser reads its fixtures from tests/fixtures, and the tests pass.'), seconds(132)],
    [{ type: 'turn/ended', stopReason: 'end_turn' }, seconds(137)],

    [prompted("Tidy the lexer's error messages."), seconds(300)],
    [said('steer-1', "I'll start with the lexer's errors."), seconds(303)],
    [called('steer-read', 'Read src/lexer.rs', 'read'), seconds(308)],
    [prompted('And keep the old error codes in them.', true), seconds(315)],
    [called('steer-search', 'Search for "ErrorCode"', 'search'), seconds(325)],
    [called('steer-edit', 'Edit src/lexer.rs', 'edit'), seconds(340)],
    [said('steer-2', "Done: the lexer's errors read plainly and keep their old codes."), seconds(355)],
    [{ type: 'turn/ended', stopReason: 'end_turn' }, seconds(357)],

    [prompted('Benchmark the parser on the big fixtures.'), seconds(600)],
    [called('stop-read', 'Read benches/parser.rs', 'read'), seconds(603)],
    [said('stop-1', "I'll build in release and run the benchmarks."), seconds(606)],
    [called('stop-bench', 'Run cargo bench -p parser', 'execute', 'in_progress'), seconds(608)],
    [{ type: 'turn/ended', stopReason: 'cancelled' }, seconds(665)],
  ];
  return journal.reduce((transcript, [event, at]) => reduceJournalEvent(transcript, event, at), createTranscript(threadId));
}

/**
 * The fake agent's `/markdown` reply (WVE-128) as recorded from a dev Host, for the `markdown` mock
 * scenario: diagrams, math, alerts and the rest of the rich Markdown agents write.
 */
export const createMarkdownShowcaseTranscript = (): AcpTranscript => markdownRecording.events
  .flatMap(({ event }): AcpTranscriptEvent[] => (event.kind === 'update' && event.notification
    ? [{ type: 'session/update', update: event.notification.update as SessionUpdate }]
    : []))
  .reduce(reduceAcpEvent, reduceAcpEvent(createTranscript('markdown'), {
    type: 'session/update',
    update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '/markdown' } },
  }));
