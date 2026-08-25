import type {
  AvailableCommand,
  CompleteElicitationNotification,
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  PermissionOption,
  PlanEntry as AcpPlanEntry,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionMode,
  SessionModeState,
  SessionUpdate,
  StopReason,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from '@agentclientprotocol/sdk';

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
    status: 'pending' | 'resolved' | 'cancelled';
    selectedOptionId?: string;
  };
};

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
  status: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'completed';
  response?: CreateElicitationResponse;
};

export type TranscriptDiagnostic = {
  id: string;
  kind: 'diagnostic';
  severity: 'info' | 'error';
  title: string;
  detail?: string;
  raw?: unknown;
};

export type TranscriptEntry =
  | TranscriptMessage
  | TranscriptToolCall
  | TranscriptPlan
  | TranscriptCompaction
  | TranscriptElicitation
  | TranscriptDiagnostic;

type TranscriptEntryInput =
  | Omit<TranscriptMessage, 'id'>
  | Omit<TranscriptToolCall, 'id'>
  | Omit<TranscriptPlan, 'id'>
  | Omit<TranscriptCompaction, 'id'>
  | Omit<TranscriptElicitation, 'id'>
  | Omit<TranscriptDiagnostic, 'id'>;

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
  nextEntrySequence: number;
};

export type AcpTranscriptEvent =
  | { type: 'session/update'; update: SessionUpdate }
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
  | { type: 'permission/requested'; requestId: string; request: RequestPermissionRequest }
  | { type: 'permission/resolved'; requestId: string; optionId?: string }
  | { type: 'permission/cancelled'; requestId: string }
  | { type: 'elicitation/requested'; requestId: string; request: CreateElicitationRequest }
  | { type: 'elicitation/resolved'; requestId: string; response: CreateElicitationResponse }
  | { type: 'elicitation/completed'; notification: CompleteElicitationNotification }
  | { type: 'turn/started' }
  | { type: 'turn/stopped'; stopReason: StopReason }
  | { type: 'turn/failed'; error: string }
  | { type: 'history/reset'; sessionId?: string };

export const createTranscript = (sessionId: string): AcpTranscript => ({
  sessionId,
  entries: [],
  availableCommands: [],
  availableModes: [],
  configOptions: [],
  turn: { status: 'idle' },
  nextEntrySequence: 1,
});

const contentEquals = (left: ContentBlock, right: ContentBlock) =>
  JSON.stringify(left) === JSON.stringify(right);

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

  if (role === 'user' && last?.kind === 'message' && last.role === 'user') {
    const matchesOptimisticEcho = last.optimistic
      && (last.messageId == null || last.messageId === messageId)
      && last.chunks.some((chunk) =>
        chunk.content.some((block) => contentEquals(block, content)));

    if (matchesOptimisticEcho) {
      entries[entries.length - 1] = {
        ...last,
        messageId,
        optimistic: false,
        chunks: last.chunks.map((chunk) => ({ ...chunk, messageId })),
      };
      return { ...model, entries };
    }

    if (!last.optimistic && last.messageId === messageId) {
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
    case 'plan_update': {
      switch (update.plan.type) {
        case 'items':
          return upsertPlan(model, {
            planId: update.plan.planId,
            format: 'entries',
            entries: update.plan.entries,
          });
        case 'markdown':
          return upsertPlan(model, {
            planId: update.plan.planId,
            format: 'markdown',
            content: update.plan.content,
          });
        case 'file':
          return upsertPlan(model, {
            planId: update.plan.planId,
            format: 'file',
            uri: update.plan.uri,
          });
      }
    }
    case 'plan_removed':
      return {
        ...model,
        entries: model.entries.filter(
          (entry) => entry.kind !== 'plan' || entry.planId !== update.planId,
        ),
      };
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
  }
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

const resolvePermission = (
  model: AcpTranscript,
  requestId: string,
  status: 'resolved' | 'cancelled',
  selectedOptionId?: string,
): AcpTranscript => {
  const index = model.entries.findIndex(
    (entry) => entry.kind === 'tool'
      && entry.permission?.requestId === requestId,
  );
  if (index === -1) return model;
  const tool = model.entries[index] as TranscriptToolCall;
  return replaceEntry(model, index, {
    ...tool,
    permission: {
      ...tool.permission!,
      status,
      ...(selectedOptionId ? { selectedOptionId } : {}),
    },
  });
};

const requestElicitation = (
  model: AcpTranscript,
  requestId: string,
  request: CreateElicitationRequest,
): AcpTranscript => appendEntry(model, {
  kind: 'elicitation',
  requestId,
  request,
  status: 'pending',
});

const resolveElicitation = (
  model: AcpTranscript,
  requestId: string,
  response: CreateElicitationResponse,
): AcpTranscript => {
  const index = model.entries.findIndex(
    (entry) => entry.kind === 'elicitation' && entry.requestId === requestId,
  );
  if (index === -1) return model;
  const current = model.entries[index] as TranscriptElicitation;
  const status = response.action === 'accept'
    ? 'accepted'
    : response.action === 'decline'
    ? 'declined'
    : 'cancelled';
  return replaceEntry(model, index, { ...current, response, status });
};

const completeElicitation = (
  model: AcpTranscript,
  notification: CompleteElicitationNotification,
): AcpTranscript => {
  const index = model.entries.findIndex((entry) =>
    entry.kind === 'elicitation'
    && entry.request.mode === 'url'
    && entry.request.elicitationId === notification.elicitationId);
  if (index === -1) return model;
  const current = model.entries[index] as TranscriptElicitation;
  return replaceEntry(model, index, { ...current, status: 'completed' });
};

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

export const reduceAcpEvent = (
  model: AcpTranscript,
  event: AcpTranscriptEvent,
): AcpTranscript => {
  switch (event.type) {
    case 'session/update':
      return reduceSessionUpdate(model, event.update);
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
        ...model,
        turn: { status: 'stopped', stopReason: event.stopReason },
      };
    case 'turn/failed':
      return { ...model, turn: { status: 'failed', error: event.error } };
    case 'permission/requested':
      return requestPermission(model, event.requestId, event.request);
    case 'permission/resolved':
      return resolvePermission(
        model,
        event.requestId,
        'resolved',
        event.optionId,
      );
    case 'permission/cancelled':
      return resolvePermission(model, event.requestId, 'cancelled');
    case 'elicitation/requested':
      return requestElicitation(model, event.requestId, event.request);
    case 'elicitation/resolved':
      return resolveElicitation(model, event.requestId, event.response);
    case 'elicitation/completed':
      return completeElicitation(model, event.notification);
  }
};
