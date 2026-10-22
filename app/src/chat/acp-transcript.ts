import type {
  AvailableCommand,
  CompleteElicitationNotification,
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationFormMode,
  ElicitationUrlMode,
  PermissionOption,
  PlanEntry as AcpPlanEntry,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionMode,
  SessionModeState,
  SessionUpdate,
  StopReason,
  SubagentUpdate,
  TerminalExitStatus,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from '@/host/protocol';

export type TranscriptMessageChunk = {
  kind: 'message' | 'thought';
  messageId?: string | null;
  content: ContentBlock[];
};

export type TranscriptMessage = {
  id: string;
  kind: 'message';
  role: 'user' | 'assistant';
  messageId?: string | null;
  optimistic: boolean;
  chunks: TranscriptMessageChunk[];
  /** Where a prompt came from, when another client or device sent it: "Jaco's iPad". */
  origin?: string;
  /** A message steered into the running turn. */
  steer?: boolean;
};

export type TranscriptToolCall = {
  id: string;
  kind: 'tool';
  toolCallId: string;
  title: string;
  name?: string | null;
  toolKind: ToolKind;
  status: ToolCallStatus;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
  permission?: {
    requestId: string;
    options: PermissionOption[];
    status: RequestStatus;
    /** The option this device chose. */
    selectedOptionId?: string;
  };
};

/**
 * A pending request waiting, or how it stopped: `answered` here, on another client
 * (`elsewhere`), `cancelled` with its turn, `withdrawn` by the agent, or `ended` while this device
 * wasn't following the session.
 */
export type RequestStatus = 'pending' | 'answered' | 'elsewhere' | 'cancelled' | 'withdrawn' | 'ended';

export type TranscriptPlan = {
  id: string;
  kind: 'plan';
  planId: string;
  format: 'entries' | 'markdown' | 'file';
  entries?: AcpPlanEntry[];
  content?: string;
  uri?: string;
};

export type TranscriptCompaction = {
  id: string;
  kind: 'compaction';
  compactionId: string;
  status: string;
  summary: ContentBlock[];
  error?: string | null;
};

export type TranscriptElicitation = {
  id: string;
  kind: 'elicitation';
  requestId: string;
  request: CreateElicitationRequest;
  /** `completed`: an accepted URL elicitation's step outside finished. */
  status: RequestStatus | 'completed';
  /** This device's answer. */
  response?: CreateElicitationResponse;
};

/** A client tool call another client runs for the agent (ADR 0009), which it waits on. */
export type TranscriptClientTool = {
  id: string;
  kind: 'client-tool';
  requestId: string;
  tool: string;
  /** The client running it: "the TUI", "Jaco's iPad". */
  runner: string;
  status: RequestStatus;
};

export type TranscriptDiagnostic = {
  id: string;
  kind: 'diagnostic';
  severity: 'info' | 'error';
  title: string;
  detail?: string;
  raw?: unknown;
};

/** What happened to a subagent, as a row in its parent's transcript, as the TUI shows them. */
export type SubagentEvent =
  | 'spawned'
  /** Back to work after being idle. */
  | 'resumed'
  | 'completed'
  | 'interrupted'
  /** Stopped for a reason other than finishing or being cancelled; `detail` says which. */
  | 'stopped'
  /** Idle without saying why. */
  | 'finished'
  /** The agent can no longer tell what the subagent is doing. */
  | 'unknown';

export type TranscriptSubagentRow = {
  id: string;
  kind: 'subagent';
  subagentId: string;
  event: SubagentEvent;
  /** The subagent's description when spawned, its reply when completed, or why it stopped. */
  detail?: string;
};

/** A message between two sessions: a parent and its subagent. */
export type TranscriptSessionMessage = {
  id: string;
  kind: 'session-message';
  messageId: string;
  senderSessionId?: string | null;
  recipientSessionId?: string | null;
  content: ContentBlock[];
};

/** When the journal events behind an entry happened, in milliseconds; none for one shown before the Host had it. */
export type EntryTimes = {
  /** The event that made it. */
  startedAt?: number;
  /** The latest event that changed it. */
  updatedAt?: number;
};

export type TranscriptEntry = (
  | TranscriptMessage
  | TranscriptToolCall
  | TranscriptPlan
  | TranscriptCompaction
  | TranscriptElicitation
  | TranscriptClientTool
  | TranscriptDiagnostic
  | TranscriptSubagentRow
  | TranscriptSessionMessage
) & EntryTimes;

type TranscriptEntryInput =
  | Omit<TranscriptMessage, 'id'>
  | Omit<TranscriptToolCall, 'id'>
  | Omit<TranscriptPlan, 'id'>
  | Omit<TranscriptCompaction, 'id'>
  | Omit<TranscriptElicitation, 'id'>
  | Omit<TranscriptClientTool, 'id'>
  | Omit<TranscriptDiagnostic, 'id'>
  | Omit<TranscriptSubagentRow, 'id'>
  | Omit<TranscriptSessionMessage, 'id'>;

/** A child session the parent created (ACP's draft Subagent Sessions RFD), with its own transcript. */
export type TranscriptSubagent = {
  sessionId: string;
  /** Its place among its siblings, from 1, for a label when it has no title. */
  number: number;
  title?: string;
  description?: string;
  /** Its work state: `running`, `idle`, `requires_action` or `unknown`. */
  state?: string;
  transcript: AcpTranscript;
};

/** A command the Host runs for the agent, shown in the tool call that embeds it. */
export type TranscriptTerminal = {
  /** Its output as written, escape sequences and all, up to the last `TERMINAL_KEEP` characters. */
  output: string;
  /** Whether earlier output was dropped to keep it to that. */
  truncated: boolean;
  exit?: TerminalExitStatus;
};

/** How much of a terminal's output a transcript keeps. */
export const TERMINAL_KEEP = 256 * 1024;

export type AcpTranscript = {
  sessionId: string;
  entries: TranscriptEntry[];
  title?: string | null;
  updatedAt?: string | null;
  availableCommands: AvailableCommand[];
  currentModeId?: string;
  availableModes: SessionMode[];
  configOptions: SessionConfigOption[];
  usage?: {
    used: number;
    size: number;
    cost?: { amount: number; currency: string } | null;
  };
  turn: {
    status: 'idle' | 'running' | 'stopped' | 'failed';
    stopReason?: StopReason;
    error?: string;
  };
  /** This session's subagents, in the order they appeared. */
  subagents: TranscriptSubagent[];
  /** Commands the Host runs for the agent, by terminal id; the root session's, for every subagent too. */
  terminals: Record<string, TranscriptTerminal>;
  nextEntrySequence: number;
};

export type AcpTranscriptEvent =
  /** An agent's update, for this session or, with `sessionId`, one of its subagents. */
  | { type: 'session/update'; update: SessionUpdate; sessionId?: string }
  /**
   * A prompt that started a turn, or with `steer` joined the running one. `own` marks this client's,
   * which replaces the optimistic message it showed; `origin` names another client's or device's.
   */
  | { type: 'prompt'; prompt: ContentBlock[]; sessionId?: string; steer?: boolean; own?: boolean; origin?: string }
  /** How a turn ended, as the transcript records it; the turn's state changes with `turn/stopped`. */
  | { type: 'turn/ended'; sessionId?: string; stopReason?: StopReason; error?: string }
  | { type: 'terminal/output'; terminalId: string; data: string }
  | { type: 'terminal/exit'; terminalId: string; status: TerminalExitStatus }
  /** The session's agent was started again (`session/reopen`); `text` says how it went. */
  | { type: 'agent/reopened'; text: string; failed: boolean; modes?: SessionModeState | null; configOptions?: SessionConfigOption[] }
  | { type: 'session/closed'; reason: string }
  /** The session was renamed through the Host; `by` starts the sentence: "You", "The agent", "The TUI". */
  | { type: 'session/renamed'; title: string; by: string }
  | {
      type: 'protocol/unknown';
      method: string;
      payload: Record<string, unknown>;
    }
  | {
      type: 'session/loaded';
      modes?: SessionModeState | null;
      configOptions?: SessionConfigOption[] | null;
    }
  /**
   * A pending request waits, in this session or with `sessionId` one of its subagents. Asking
   * again for one already shown makes it wait again, as after an answer that failed.
   */
  | { type: 'permission/requested'; requestId: string; request: RequestPermissionRequest; sessionId?: string }
  | { type: 'elicitation/requested'; requestId: string; request: CreateElicitationRequest; sessionId?: string }
  | { type: 'clientTool/requested'; requestId: string; tool: string; runner: string; sessionId?: string }
  /** This device answered a pending request. */
  | { type: 'permission/resolved'; requestId: string; optionId?: string }
  | { type: 'elicitation/resolved'; requestId: string; response: CreateElicitationResponse }
  /** A pending request stopped waiting, as the Host says (`pending/resolved`). */
  | { type: 'request/resolved'; requestId: string; status: Exclude<RequestStatus, 'pending'> }
  /** Only `waiting` still wait: the rest stopped while this device wasn't following the session. */
  | { type: 'requests/settled'; waiting: string[] }
  | { type: 'elicitation/completed'; notification: CompleteElicitationNotification }
  | { type: 'turn/started' }
  | { type: 'turn/stopped'; stopReason: StopReason }
  | { type: 'turn/failed'; error: string }
  | { type: 'history/reset'; sessionId?: string }
  /** Something the Host tells the session's clients, such as why the agent can't use client tools. */
  | { type: 'notice'; severity: 'info' | 'error'; title: string; detail?: string };

/** A form elicitation. A mode this schema doesn't know is a plain string, so `mode` alone can't tell. */
export type FormElicitation = CreateElicitationRequest & ElicitationFormMode & { mode: 'form' };
export type UrlElicitation = CreateElicitationRequest & ElicitationUrlMode & { mode: 'url' };

export const formElicitation = (request: CreateElicitationRequest): FormElicitation | undefined =>
  request.mode === 'form' && 'requestedSchema' in request ? request as FormElicitation : undefined;

export const urlElicitation = (request: CreateElicitationRequest): UrlElicitation | undefined =>
  request.mode === 'url' && 'elicitationId' in request && 'url' in request ? request as UrlElicitation : undefined;

export const createTranscript = (sessionId: string): AcpTranscript => ({
  sessionId,
  entries: [],
  availableCommands: [],
  availableModes: [],
  configOptions: [],
  turn: { status: 'idle' },
  subagents: [],
  terminals: {},
  nextEntrySequence: 1,
});

/** JSON with every object's keys in order, so the same content compares equal however it was written. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const contentEquals = (left: ContentBlock, right: ContentBlock) => canonical(left) === canonical(right);

const nextEntryId = (model: AcpTranscript) =>
  `${model.sessionId}:entry:${model.nextEntrySequence}`;

const appendProtocolMessage = (
  model: AcpTranscript,
  role: 'user' | 'assistant',
  chunkKind: 'message' | 'thought',
  messageId: string | null | undefined,
  content: ContentBlock,
): AcpTranscript => {
  const entries = [...model.entries];
  const last = entries.at(-1);

  if (role === 'user') {
    let optimisticIndex = -1;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (
        entry.kind === 'message'
        && entry.role === 'user'
        && entry.optimistic
        && (entry.messageId == null || entry.messageId === messageId)
        && entry.chunks.some((chunk) =>
          chunk.content.some((block) => contentEquals(block, content)))
      ) {
        optimisticIndex = index;
        break;
      }
    }
    if (optimisticIndex !== -1) {
      const optimistic = entries[optimisticIndex] as TranscriptMessage;
      entries[optimisticIndex] = {
        ...optimistic,
        messageId,
        optimistic: false,
        chunks: optimistic.chunks.map((chunk) => ({ ...chunk, messageId })),
      };
      return { ...model, entries };
    }

    if (last?.kind === 'message' && last.role === 'user' && !last.optimistic && last.messageId === messageId) {
      const chunks = [...last.chunks];
      const lastChunk = chunks.at(-1);
      if (lastChunk?.kind === chunkKind && lastChunk.messageId === messageId) {
        chunks[chunks.length - 1] = {
          ...lastChunk,
          content: [...lastChunk.content, content],
        };
      } else {
        chunks.push({ kind: chunkKind, messageId, content: [content] });
      }
      entries[entries.length - 1] = { ...last, chunks };
      return { ...model, entries };
    }
  }

  if (role === 'assistant' && last?.kind === 'message' && last.role === 'assistant') {
    const chunks = [...last.chunks];
    const lastChunk = chunks.at(-1);
    if (lastChunk?.kind === chunkKind && lastChunk.messageId === messageId) {
      chunks[chunks.length - 1] = {
        ...lastChunk,
        content: [...lastChunk.content, content],
      };
    } else {
      chunks.push({ kind: chunkKind, messageId, content: [content] });
    }
    entries[entries.length - 1] = { ...last, chunks };
    return { ...model, entries };
  }

  entries.push({
    id: nextEntryId(model),
    kind: 'message',
    role,
    messageId,
    optimistic: false,
    chunks: [{ kind: chunkKind, messageId, content: [content] }],
  });
  return {
    ...model,
    entries,
    nextEntrySequence: model.nextEntrySequence + 1,
  };
};

const replaceEntry = (
  model: AcpTranscript,
  index: number,
  entry: TranscriptEntry,
): AcpTranscript => {
  const entries = [...model.entries];
  entries[index] = entry;
  return { ...model, entries };
};

const appendEntry = (
  model: AcpTranscript,
  entry: TranscriptEntryInput,
): AcpTranscript => ({
  ...model,
  entries: [
    ...model.entries,
    { ...entry, id: nextEntryId(model) } as TranscriptEntry,
  ],
  nextEntrySequence: model.nextEntrySequence + 1,
});

type ToolPatch = {
  toolCallId: string;
  title?: string | null;
  name?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
};

const toolFromPatch = (
  model: AcpTranscript,
  patch: ToolPatch,
  missingIsFailure: boolean,
): TranscriptToolCall => ({
  id: nextEntryId(model),
  kind: 'tool',
  toolCallId: patch.toolCallId,
  title: missingIsFailure ? 'Tool call not found' : (patch.title ?? 'Tool call'),
  name: patch.name,
  toolKind: missingIsFailure ? 'other' : (patch.kind ?? 'other'),
  status: missingIsFailure ? 'failed' : (patch.status ?? 'pending'),
  content: missingIsFailure
    ? [{
        type: 'content',
        content: { type: 'text', text: 'Received an update for an unknown tool call.' },
      }]
    : (patch.content ?? []),
  locations: patch.locations ?? [],
  ...(patch.rawInput === undefined ? {} : { rawInput: patch.rawInput }),
  ...(patch.rawOutput === undefined ? {} : { rawOutput: patch.rawOutput }),
});

const upsertTool = (
  model: AcpTranscript,
  patch: ToolPatch,
  missingIsFailure: boolean,
): AcpTranscript => {
  const index = model.entries.findIndex(
    (entry) => entry.kind === 'tool' && entry.toolCallId === patch.toolCallId,
  );
  if (index === -1) {
    const entry = toolFromPatch(model, patch, missingIsFailure);
    return {
      ...model,
      entries: [...model.entries, entry],
      nextEntrySequence: model.nextEntrySequence + 1,
    };
  }

  const current = model.entries[index] as TranscriptToolCall;
  const terminalStatus = patch.status === 'completed' || patch.status === 'failed';
  return replaceEntry(model, index, {
    ...current,
    ...(patch.title == null ? {} : { title: patch.title }),
    ...(patch.name == null ? {} : { name: patch.name }),
    ...(patch.kind == null ? {} : { toolKind: patch.kind }),
    ...(patch.status == null ? {} : { status: patch.status }),
    ...(patch.content == null ? {} : { content: patch.content }),
    ...(patch.locations == null ? {} : { locations: patch.locations }),
    ...(patch.rawInput === undefined ? {} : { rawInput: patch.rawInput }),
    ...(patch.rawOutput === undefined ? {} : { rawOutput: patch.rawOutput }),
    ...(terminalStatus && current.permission?.status === 'pending'
      ? { permission: { ...current.permission, status: 'cancelled' as const } }
      : {}),
  });
};

const upsertPlan = (
  model: AcpTranscript,
  plan: Omit<TranscriptPlan, 'id' | 'kind'>,
): AcpTranscript => {
  const index = model.entries.findIndex(
    (entry) => entry.kind === 'plan' && entry.planId === plan.planId,
  );
  const entry: TranscriptPlan = {
    id: index === -1 ? nextEntryId(model) : model.entries[index].id,
    kind: 'plan',
    ...plan,
  };
  if (index !== -1) return replaceEntry(model, index, entry);
  return {
    ...model,
    entries: [...model.entries, entry],
    nextEntrySequence: model.nextEntrySequence + 1,
  };
};

const upsertCompaction = (
  model: AcpTranscript,
  compactionId: string,
  patch: Partial<Pick<TranscriptCompaction, 'status' | 'summary' | 'error'>>,
): AcpTranscript => {
  const index = model.entries.findIndex(
    (entry) => entry.kind === 'compaction'
      && entry.compactionId === compactionId,
  );
  if (index === -1) {
    return appendEntry(model, {
      kind: 'compaction',
      compactionId,
      status: patch.status ?? 'in_progress',
      summary: patch.summary ?? [],
      ...(patch.error === undefined ? {} : { error: patch.error }),
    });
  }
  const current = model.entries[index] as TranscriptCompaction;
  return replaceEntry(model, index, { ...current, ...patch });
};

const reduceSessionUpdate = (
  model: AcpTranscript,
  update: SessionUpdate,
): AcpTranscript => {
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
      return appendProtocolMessage(
        model,
        'user',
        'message',
        update.messageId,
        update.content,
      );
    case 'agent_message_chunk':
      return appendProtocolMessage(
        model,
        'assistant',
        'message',
        update.messageId,
        update.content,
      );
    case 'agent_thought_chunk':
      return appendProtocolMessage(
        model,
        'assistant',
        'thought',
        update.messageId,
        update.content,
      );
    case 'tool_call':
      return upsertTool(model, update, false);
    case 'tool_call_update':
      return upsertTool(model, update, true);
    case 'plan':
      return upsertPlan(model, {
        planId: 'stable',
        format: 'entries',
        entries: update.entries,
      });
    case 'subagent_update':
      return applySubagentUpdate(model, update);
    case 'session_message':
      return upsertSessionMessage(model, update, (current) => update.content === undefined
        ? current
        : update.content ?? []);
    case 'session_message_chunk':
      return upsertSessionMessage(model, update, (current) => [...current, update.content]);
    case 'available_commands_update':
      return { ...model, availableCommands: update.availableCommands };
    case 'current_mode_update':
      return { ...model, currentModeId: update.currentModeId };
    case 'config_option_update':
      return { ...model, configOptions: update.configOptions };
    case 'session_info_update':
      return {
        ...model,
        ...(update.title === undefined ? {} : { title: update.title }),
        ...(update.updatedAt === undefined ? {} : { updatedAt: update.updatedAt }),
      };
    case 'usage_update':
      return {
        ...model,
        usage: {
          used: update.used,
          size: update.size,
          cost: update.cost === undefined ? model.usage?.cost : update.cost,
        },
      };
    case 'compaction_update':
      return upsertCompaction(model, update.compactionId, {
        status: update.status,
        ...(update.summary === undefined
          ? {}
          : { summary: update.summary ?? [] }),
        ...(update.error === undefined ? {} : { error: update.error }),
      });
    case 'compaction_summary_chunk': {
      const index = model.entries.findIndex(
        (entry) => entry.kind === 'compaction'
          && entry.compactionId === update.compactionId,
      );
      const current = index === -1
        ? undefined
        : model.entries[index] as TranscriptCompaction;
      return upsertCompaction(model, update.compactionId, {
        summary: [...(current?.summary ?? []), update.content],
      });
    }
    default:
      // A kind from a newer ACP than this app knows.
      return model;
  }
};

/** The text of a message's blocks, for previews. */
export const blocksText = (blocks: ContentBlock[]) =>
  blocks.map((block) => block.type === 'text' ? block.text : '').join('');

/** What the transcript's agent said last, for a subagent's "Completed" row. */
const lastReply = (model: AcpTranscript): string | undefined => {
  for (let index = model.entries.length - 1; index >= 0; index -= 1) {
    const entry = model.entries[index];
    if (entry.kind === 'message' && entry.role === 'assistant') {
      const text = blocksText(entry.chunks.filter(({ kind }) => kind === 'message').flatMap(({ content }) => content)).trim();
      if (text) return text;
    }
  }
  return undefined;
};

const stopDetail: Partial<Record<StopReason, string>> = {
  max_tokens: 'It reached its token limit',
  max_turn_requests: 'It reached its request limit',
  refusal: 'It refused to continue',
};

/** The row for a subagent's change of work state, if it's one worth a row, as the TUI decides. */
const stateRow = (
  previous: string | undefined,
  state: NonNullable<SubagentUpdate['state']>,
  reply: string | undefined,
): Pick<TranscriptSubagentRow, 'event' | 'detail'> | undefined => {
  const wasIdle = previous === 'idle';
  switch (state.state) {
    case 'running':
      return wasIdle ? { event: 'resumed' } : undefined;
    case 'idle': {
      if (wasIdle) return undefined;
      const stopReason = 'stopReason' in state ? state.stopReason as StopReason | null | undefined : undefined;
      if (stopReason === 'end_turn') return { event: 'completed', ...(reply ? { detail: reply } : {}) };
      if (stopReason === 'cancelled') return { event: 'interrupted' };
      if (stopReason) return { event: 'stopped', detail: stopDetail[stopReason] ?? 'It stopped' };
      return { event: 'finished' };
    }
    case 'unknown':
      return previous === 'unknown' ? undefined : { event: 'unknown' };
    default:
      return undefined;
  }
};

/** A field an update patches: left out it stays, `null` clears it, a value replaces it. */
const patched = (current: string | undefined, value: string | null | undefined) =>
  value === undefined ? current : value?.trim() || undefined;

/**
 * A subagent appeared, or what its parent says about it changed. Its arrival and the end of its
 * work become rows in the parent's transcript.
 */
const applySubagentUpdate = (model: AcpTranscript, update: SubagentUpdate): AcpTranscript => {
  const index = model.subagents.findIndex(({ sessionId }) => sessionId === update.sessionId);
  const current: TranscriptSubagent = index === -1
    ? { sessionId: update.sessionId, number: model.subagents.length + 1, transcript: createTranscript(update.sessionId) }
    : model.subagents[index];
  const subagent: TranscriptSubagent = {
    ...current,
    title: patched(current.title, update.title),
    description: patched(current.description, update.description),
    state: update.state === undefined ? current.state : update.state?.state,
  };
  const subagents = index === -1
    ? [...model.subagents, subagent]
    : model.subagents.map((item, at) => at === index ? subagent : item);
  let next: AcpTranscript = { ...model, subagents };
  if (index === -1) {
    next = appendEntry(next, {
      kind: 'subagent',
      subagentId: subagent.sessionId,
      event: 'spawned',
      ...(subagent.description ? { detail: subagent.description } : {}),
    });
  }
  const row = update.state ? stateRow(current.state, update.state, lastReply(subagent.transcript)) : undefined;
  if (row) next = appendEntry(next, { kind: 'subagent', subagentId: subagent.sessionId, ...row });
  return next;
};

const upsertSessionMessage = (
  model: AcpTranscript,
  update: { messageId: string; senderSessionId?: string | null; recipientSessionId?: string | null },
  content: (current: ContentBlock[]) => ContentBlock[],
): AcpTranscript => {
  const index = model.entries.findIndex((entry) => entry.kind === 'session-message' && entry.messageId === update.messageId);
  if (index === -1) {
    return appendEntry(model, {
      kind: 'session-message',
      messageId: update.messageId,
      senderSessionId: update.senderSessionId,
      recipientSessionId: update.recipientSessionId,
      content: content([]),
    });
  }
  const current = model.entries[index] as TranscriptSessionMessage;
  // Who sent it and who it's for, once known, stay known.
  return replaceEntry(model, index, {
    ...current,
    senderSessionId: update.senderSessionId ?? current.senderSessionId,
    recipientSessionId: update.recipientSessionId ?? current.recipientSessionId,
    content: content(current.content),
  });
};

/** Applies `reduce` to the transcript of `sessionId`: this one, or one of its subagents' at any depth. */
const inSession = (
  model: AcpTranscript,
  sessionId: string | undefined,
  reduce: (transcript: AcpTranscript) => AcpTranscript,
): AcpTranscript => {
  if (sessionId === undefined || sessionId === model.sessionId) return reduce(model);
  for (let index = 0; index < model.subagents.length; index += 1) {
    const subagent = model.subagents[index];
    if (!containsSession(subagent.transcript, sessionId)) continue;
    const transcript = inSession(subagent.transcript, sessionId, reduce);
    const subagents = [...model.subagents];
    subagents[index] = { ...subagent, transcript };
    return { ...model, subagents };
  }
  // A session this one doesn't know: nothing shows it.
  return model;
};

const containsSession = (model: AcpTranscript, sessionId: string): boolean =>
  model.sessionId === sessionId || model.subagents.some(({ transcript }) => containsSession(transcript, sessionId));

/** The subagent with `sessionId`, at any depth. */
export const findSubagent = (model: AcpTranscript, sessionId: string): TranscriptSubagent | undefined => {
  for (const subagent of model.subagents) {
    if (subagent.sessionId === sessionId) return subagent;
    const nested = findSubagent(subagent.transcript, sessionId);
    if (nested) return nested;
  }
  return undefined;
};

/** What a session is called in a transcript: "Main" for the root, a subagent's title, or "Subagent N". */
export const sessionLabel = (root: AcpTranscript, sessionId: string | null | undefined): string => {
  if (!sessionId) return 'another agent';
  if (sessionId === root.sessionId) return 'Main';
  const subagent = findSubagent(root, sessionId);
  return subagent ? subagent.title ?? `Subagent ${subagent.number}` : 'another agent';
};

const sameContent = (left: ContentBlock[], right: ContentBlock[]) => canonical(left) === canonical(right);

/**
 * A turn's prompt, or a steer, as the journal records it: a message of its own, after what the
 * agent said before. This client's own replaces the optimistic one it showed while sending.
 */
const appendPrompt = (
  model: AcpTranscript,
  event: Extract<AcpTranscriptEvent, { type: 'prompt' }>,
): AcpTranscript => {
  let current = model;
  if (event.own) {
    // This device's prompts arrive in the order it sent them: one whose content reads differently
    // from what was sent still replaces the oldest it showed.
    const optimistic = (entry: TranscriptEntry): entry is TranscriptMessage => entry.kind === 'message' && entry.optimistic;
    let index = model.entries.findIndex((entry) => optimistic(entry) && sameContent(entry.chunks.flatMap(({ content }) => content), event.prompt));
    if (index === -1) index = model.entries.findIndex(optimistic);
    if (index !== -1) current = { ...model, entries: model.entries.filter((_, at) => at !== index) };
  }
  if (event.prompt.length === 0) return current;
  return appendEntry(current, {
    kind: 'message',
    role: 'user',
    optimistic: false,
    chunks: [{ kind: 'message', content: event.prompt }],
    ...(event.origin ? { origin: event.origin } : {}),
    ...(event.steer ? { steer: true } : {}),
  });
};

// As the TUI words them.
const stopReasonText: Partial<Record<StopReason, string>> = {
  cancelled: 'Turn cancelled',
  max_tokens: 'Stopped: the agent reached its token limit',
  max_turn_requests: 'Stopped: the turn made too many model requests',
  refusal: 'The agent refused to continue',
};

/** A turn's end, in the transcript: nothing for one that finished, otherwise why it didn't. */
const recordTurnEnd = (model: AcpTranscript, event: Extract<AcpTranscriptEvent, { type: 'turn/ended' }>): AcpTranscript => {
  if (event.error !== undefined) {
    return appendEntry(model, { kind: 'diagnostic', severity: 'error', title: 'Turn failed', detail: event.error });
  }
  if (!event.stopReason || event.stopReason === 'end_turn') return model;
  return appendEntry(model, {
    kind: 'diagnostic',
    severity: 'info',
    title: stopReasonText[event.stopReason] ?? 'Stopped for an unrecognized reason',
  });
};

const appendTerminalOutput = (model: AcpTranscript, terminalId: string, data: string): AcpTranscript => {
  const current = model.terminals[terminalId] ?? { output: '', truncated: false };
  let output = current.output + data;
  let truncated = current.truncated;
  if (output.length > TERMINAL_KEEP) {
    output = output.slice(output.length - TERMINAL_KEEP);
    truncated = true;
  }
  return { ...model, terminals: { ...model.terminals, [terminalId]: { ...current, output, truncated } } };
};

const requestPermission = (
  model: AcpTranscript,
  requestId: string,
  request: RequestPermissionRequest,
): AcpTranscript => {
  const withTool = upsertTool(model, request.toolCall, false);
  const index = withTool.entries.findIndex(
    (entry) => entry.kind === 'tool'
      && entry.toolCallId === request.toolCall.toolCallId,
  );
  const tool = withTool.entries[index] as TranscriptToolCall;
  return replaceEntry(withTool, index, {
    ...tool,
    permission: {
      requestId,
      options: request.options,
      status: 'pending',
    },
  });
};

/** The pending request `requestId`'s entry, or undefined for another entry. */
const requestOf = (entry: TranscriptEntry, requestId: string) => {
  if (entry.kind === 'tool') return entry.permission?.requestId === requestId;
  return (entry.kind === 'elicitation' || entry.kind === 'client-tool') && entry.requestId === requestId;
};

const statusOf = (entry: TranscriptEntry): TranscriptElicitation['status'] | undefined => {
  if (entry.kind === 'tool') return entry.permission?.status;
  return entry.kind === 'elicitation' || entry.kind === 'client-tool' ? entry.status : undefined;
};

const withStatus = (entry: TranscriptEntry, status: RequestStatus): TranscriptEntry => {
  if (entry.kind === 'tool' && entry.permission) return { ...entry, permission: { ...entry.permission, status } };
  if (entry.kind === 'elicitation' || entry.kind === 'client-tool') return { ...entry, status };
  return entry;
};

/** Changes the entry of pending request `requestId`, in this session or whichever subagent's it is. */
const updateRequest = (
  model: AcpTranscript,
  requestId: string,
  change: (entry: TranscriptEntry) => TranscriptEntry,
): AcpTranscript => {
  const index = model.entries.findIndex((entry) => requestOf(entry, requestId));
  if (index !== -1) {
    const changed = change(model.entries[index]);
    return changed === model.entries[index] ? model : replaceEntry(model, index, changed);
  }
  for (let at = 0; at < model.subagents.length; at += 1) {
    const subagent = model.subagents[at];
    const transcript = updateRequest(subagent.transcript, requestId, change);
    if (transcript === subagent.transcript) continue;
    const subagents = [...model.subagents];
    subagents[at] = { ...subagent, transcript };
    return { ...model, subagents };
  }
  return model;
};

/** Every entry of a request still pending, in this session and its subagents, changed. */
const updatePending = (
  model: AcpTranscript,
  change: (entry: TranscriptEntry, requestId: string) => TranscriptEntry,
): AcpTranscript => {
  let changed = false;
  const entries = model.entries.map((entry) => {
    if (statusOf(entry) !== 'pending') return entry;
    const requestId = entry.kind === 'tool' ? entry.permission!.requestId : (entry as TranscriptElicitation | TranscriptClientTool).requestId;
    const next = change(entry, requestId);
    if (next !== entry) changed = true;
    return next;
  });
  const subagents = model.subagents.map((subagent) => {
    const transcript = updatePending(subagent.transcript, change);
    if (transcript === subagent.transcript) return subagent;
    changed = true;
    return { ...subagent, transcript };
  });
  return changed ? { ...model, entries, subagents } : model;
};

/** Shown again for one already in the transcript, or added. */
const requestElicitation = (
  model: AcpTranscript,
  requestId: string,
  request: CreateElicitationRequest,
): AcpTranscript => {
  const index = model.entries.findIndex((entry) => entry.kind === 'elicitation' && entry.requestId === requestId);
  if (index !== -1) {
    const { response: _answered, ...current } = model.entries[index] as TranscriptElicitation;
    return replaceEntry(model, index, { ...current, request, status: 'pending' });
  }
  return appendEntry(model, { kind: 'elicitation', requestId, request, status: 'pending' });
};

const requestClientTool = (
  model: AcpTranscript,
  event: Extract<AcpTranscriptEvent, { type: 'clientTool/requested' }>,
): AcpTranscript => {
  const index = model.entries.findIndex((entry) => entry.kind === 'client-tool' && entry.requestId === event.requestId);
  const entry = { kind: 'client-tool' as const, requestId: event.requestId, tool: event.tool, runner: event.runner, status: 'pending' as const };
  return index === -1 ? appendEntry(model, entry) : replaceEntry(model, index, { ...entry, id: model.entries[index].id });
};

/** How the Host says a request stopped waiting. This device's own answer keeps what it chose. */
const resolveRequest = (
  model: AcpTranscript,
  requestId: string,
  status: Exclude<RequestStatus, 'pending'>,
): AcpTranscript => updateRequest(model, requestId, (entry) => {
  const current = statusOf(entry);
  if (current === status || (status === 'answered' && current !== 'pending')) return entry;
  return withStatus(entry, status);
});

/** Answered here: the option chosen, or the response given. */
const answerPermission = (model: AcpTranscript, requestId: string, optionId?: string): AcpTranscript =>
  updateRequest(model, requestId, (entry) => entry.kind === 'tool' && entry.permission
    ? { ...entry, permission: { ...entry.permission, status: 'answered', ...(optionId ? { selectedOptionId: optionId } : {}) } }
    : entry);

const answerElicitation = (model: AcpTranscript, requestId: string, response: CreateElicitationResponse): AcpTranscript =>
  updateRequest(model, requestId, (entry) => entry.kind === 'elicitation' ? { ...entry, status: 'answered', response } : entry);

const completeElicitation = (
  model: AcpTranscript,
  notification: CompleteElicitationNotification,
): AcpTranscript => {
  const index = model.entries.findIndex((entry) =>
    entry.kind === 'elicitation'
    && urlElicitation(entry.request)?.elicitationId === notification.elicitationId);
  if (index === -1) {
    // A subagent's, perhaps.
    for (let at = 0; at < model.subagents.length; at += 1) {
      const subagent = model.subagents[at];
      const transcript = completeElicitation(subagent.transcript, notification);
      if (transcript === subagent.transcript) continue;
      const subagents = [...model.subagents];
      subagents[at] = { ...subagent, transcript };
      return { ...model, subagents };
    }
    return model;
  }
  const current = model.entries[index] as TranscriptElicitation;
  return replaceEntry(model, index, { ...current, status: 'completed' });
};

/** A session's subagents, theirs, and so on. */
export const allSubagents = (model: AcpTranscript): TranscriptSubagent[] =>
  model.subagents.flatMap((subagent) => [subagent, ...allSubagents(subagent.transcript)]);

/** Whether a request this device can answer waits in this transcript, not counting its subagents'. */
export const waitsForAnswer = (model: AcpTranscript) => model.entries.some((entry) => statusOf(entry) === 'pending' && entry.kind !== 'client-tool');

export const queueOptimisticPrompt = (
  model: AcpTranscript,
  localId: string,
  content: ContentBlock[],
): AcpTranscript => ({
  ...model,
  entries: [
    ...model.entries,
    {
      id: localId,
      kind: 'message',
      role: 'user',
      optimistic: true,
      chunks: [{ kind: 'message', content }],
    },
  ],
});

const settleOptimisticPrompts = (model: AcpTranscript): AcpTranscript => ({
  ...model,
  entries: model.entries.map((entry) =>
    entry.kind === 'message' && entry.role === 'user' && entry.optimistic
      ? { ...entry, optimistic: false }
      : entry
  ),
});

/**
 * The entries an event made or changed, stamped with when it happened. Entries are appended or
 * replaced where they stand; the only one an event removes is this device's prompt, as the Host's
 * copy replaces it.
 */
const stampEntries = (before: TranscriptEntry[], after: TranscriptEntry[], at: number): TranscriptEntry[] => {
  if (after === before) return after;
  let index = 0;
  return after.map((entry) => {
    if (before[index] && before[index].id !== entry.id && before[index + 1]?.id === entry.id) index += 1;
    const previous = before[index]?.id === entry.id ? before[index++] : undefined;
    if (previous === entry) return entry;
    return { ...entry, startedAt: previous?.startedAt ?? at, updatedAt: at };
  });
};

const stampTranscript = (before: AcpTranscript | undefined, after: AcpTranscript, at: number): AcpTranscript => {
  if (after === before) return after;
  const subagents = after.subagents === before?.subagents
    ? after.subagents
    : after.subagents.map((subagent) => {
        const earlier = before?.subagents.find(({ sessionId }) => sessionId === subagent.sessionId);
        return earlier?.transcript === subagent.transcript ? subagent : { ...subagent, transcript: stampTranscript(earlier?.transcript, subagent.transcript, at) };
      });
  return { ...after, entries: stampEntries(before?.entries ?? [], after.entries, at), subagents };
};

/** `reduceAcpEvent` for a journal event, recording when it happened on the entries it made or changed. */
export const reduceJournalEvent = (model: AcpTranscript, event: AcpTranscriptEvent, at: number): AcpTranscript =>
  stampTranscript(model, reduceAcpEvent(model, event), at);

export const reduceAcpEvent = (
  model: AcpTranscript,
  event: AcpTranscriptEvent,
): AcpTranscript => {
  switch (event.type) {
    case 'session/update':
      return inSession(model, event.sessionId, (transcript) => reduceSessionUpdate(transcript, event.update));
    case 'prompt':
      return inSession(model, event.sessionId, (transcript) => appendPrompt(transcript, event));
    case 'turn/ended':
      return inSession(model, event.sessionId, (transcript) => recordTurnEnd(transcript, event));
    case 'terminal/output':
      return appendTerminalOutput(model, event.terminalId, event.data);
    case 'terminal/exit': {
      const current = model.terminals[event.terminalId] ?? { output: '', truncated: false };
      return { ...model, terminals: { ...model.terminals, [event.terminalId]: { ...current, exit: event.status } } };
    }
    case 'agent/reopened':
      return {
        ...appendEntry(model, { kind: 'diagnostic', severity: event.failed ? 'error' : 'info', title: event.text }),
        ...(event.modes ? { currentModeId: event.modes.currentModeId, availableModes: event.modes.availableModes } : {}),
        ...(event.configOptions ? { configOptions: event.configOptions } : {}),
      };
    case 'session/renamed':
      return {
        ...appendEntry(model, { kind: 'diagnostic', severity: 'info', title: `${event.by} renamed this session to “${event.title}”` }),
        title: event.title,
      };
    case 'session/closed':
      return {
        ...settleOptimisticPrompts(appendEntry(model, { kind: 'diagnostic', severity: 'info', title: 'The session closed', detail: event.reason })),
        turn: { status: 'idle' },
      };
    case 'notice':
      return appendEntry(model, {
        kind: 'diagnostic',
        severity: event.severity,
        title: event.title,
        ...(event.detail === undefined ? {} : { detail: event.detail }),
      });
    case 'protocol/unknown':
      return appendEntry(model, {
        kind: 'diagnostic',
        severity: 'info',
        title: event.method === 'session/update'
          ? 'Unsupported ACP update'
          : 'Unsupported ACP message',
        detail: event.method,
        raw: event.payload,
      });
    case 'session/loaded':
      return {
        ...model,
        ...(event.modes
          ? {
              currentModeId: event.modes.currentModeId,
              availableModes: event.modes.availableModes,
            }
          : {}),
        ...(event.configOptions
          ? { configOptions: event.configOptions }
          : {}),
      };
    case 'history/reset':
      return createTranscript(event.sessionId ?? model.sessionId);
    case 'turn/started':
      return { ...model, turn: { status: 'running' } };
    case 'turn/stopped':
      return {
        ...settleOptimisticPrompts(model),
        turn: { status: 'stopped', stopReason: event.stopReason },
      };
    case 'turn/failed':
      return {
        ...settleOptimisticPrompts(model),
        turn: { status: 'failed', error: event.error },
      };
    case 'permission/requested':
      return inSession(model, event.sessionId, (transcript) => requestPermission(transcript, event.requestId, event.request));
    case 'elicitation/requested':
      return inSession(model, event.sessionId, (transcript) => requestElicitation(transcript, event.requestId, event.request));
    case 'clientTool/requested':
      return inSession(model, event.sessionId, (transcript) => requestClientTool(transcript, event));
    case 'permission/resolved':
      return answerPermission(model, event.requestId, event.optionId);
    case 'elicitation/resolved':
      return answerElicitation(model, event.requestId, event.response);
    case 'request/resolved':
      return resolveRequest(model, event.requestId, event.status);
    case 'requests/settled': {
      const waiting = new Set(event.waiting);
      return updatePending(model, (entry, requestId) => waiting.has(requestId) ? entry : withStatus(entry, 'ended'));
    }
    case 'elicitation/completed':
      return completeElicitation(model, event.notification);
  }
};
