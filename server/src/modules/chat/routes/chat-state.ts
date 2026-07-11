import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { defineRoute } from '../../../server/routes';
import type { MastraDBMessage } from '@mastra/core/agent';
import { attachmentIdFromReference, attachmentUrlPath } from '../../attachments/storage';
import { getAuthUserFromHeader } from '../../../agent/mastra/auth';
import { isCompactToolHistoryTextPart } from '../../../agent/mastra/compact-tool-history-processor';
import type { AgentService } from '../../../agent/service';
import { threadCompactionDisplayMessage } from '../../../agent/thread-compaction';
import {
  contextUsageRecallOptions,
  estimateContextTokens,
  estimateMemoryContextTokens,
} from '../../../agent/context-token-estimate';

const askUserToolName = 'ask_user';

type NormalizedAskUserAnswer = {
  id: string;
  finalAnswer: string;
  selectedOptionId?: string;
  customAnswer?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getToolInvocation = (part: Record<string, unknown>) =>
  typeof part.toolInvocation === 'object' && part.toolInvocation !== null
    ? (part.toolInvocation as Record<string, unknown>)
    : undefined;

const getToolName = (part: Record<string, unknown>) => {
  const invocation = getToolInvocation(part);
  if (typeof invocation?.toolName === 'string') return invocation.toolName;
  if (typeof part.toolName === 'string') return part.toolName;
  if (
    typeof part.type === 'string' && part.type.startsWith('tool-') &&
    !['tool-call', 'tool-invocation', 'tool-result'].includes(part.type)
  ) {
    return part.type.slice('tool-'.length);
  }
  return 'tool';
};

const parseJsonString = (value: unknown) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const getToolArgs = (part: Record<string, unknown>) => {
  const invocation = getToolInvocation(part);
  return parseJsonString(invocation?.args ?? invocation?.input ?? part.args ?? part.input ?? {});
};

const getToolResult = (part: Record<string, unknown>) => {
  const invocation = getToolInvocation(part);
  return parseJsonString(invocation?.result ?? invocation?.output ?? part.result ?? part.output);
};

const nonEmptyString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const getToolCallId = (
  part: Record<string, unknown>,
  messageId: string,
  partIndex: number,
  toolName: string,
) =>
  typeof getToolInvocation(part)?.toolCallId === 'string'
    ? getToolInvocation(part)!.toolCallId as string
    : typeof part.toolCallId === 'string'
    ? part.toolCallId
    : `${messageId}-${partIndex}-${toolName}`;

const normalizeAskUserQuestions = (value: unknown): Array<Record<string, unknown>> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const questions = value.flatMap((question): Array<Record<string, unknown>> => {
    if (!isRecord(question)) return [];
    const id = nonEmptyString(question.id);
    const text = nonEmptyString(question.question);
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option): Array<Record<string, unknown>> => {
        if (!isRecord(option)) return [];
        const optionId = nonEmptyString(option.id);
        const label = nonEmptyString(option.label);
        if (!optionId || !label) return [];
        return [{
          id: optionId,
          label,
          ...(nonEmptyString(option.description) ? { description: nonEmptyString(option.description) } : {}),
        }];
      })
      : [];

    if (!id || !text || options.length < 2) return [];
    return [{
      id,
      question: text,
      options,
      ...(nonEmptyString(question.header) ? { header: nonEmptyString(question.header) } : {}),
    }];
  });

  return questions.length > 0 ? questions : undefined;
};

const normalizeAskUserAnswers = (value: unknown): NormalizedAskUserAnswer[] | undefined => {
  if (!Array.isArray(value)) return undefined;

  const answers = value.map((answer) => {
    if (!isRecord(answer)) return undefined;
    const id = nonEmptyString(answer.id);
    const finalAnswer = nonEmptyString(answer.finalAnswer);
    if (!id || !finalAnswer) return undefined;

    return {
      id,
      finalAnswer,
      ...(nonEmptyString(answer.selectedOptionId) ? { selectedOptionId: nonEmptyString(answer.selectedOptionId) } : {}),
      ...(nonEmptyString(answer.customAnswer) ? { customAnswer: nonEmptyString(answer.customAnswer) } : {}),
    };
  }).filter((answer): answer is NormalizedAskUserAnswer => Boolean(answer));

  return answers.length > 0 ? answers : undefined;
};

const normalizeAskUserResume = (value: unknown) => {
  if (!isRecord(value)) return undefined;
  if (value.action === 'cancel') {
    return {
      action: 'cancel',
      ...(nonEmptyString(value.reason) ? { reason: nonEmptyString(value.reason) } : {}),
    };
  }

  if (value.action === 'submit') {
    const answers = normalizeAskUserAnswers(value.answers);
    return answers ? { action: 'submit', answers } : undefined;
  }

  if (value.cancelled === true) return { action: 'cancel' };
  const answers = normalizeAskUserAnswers(value.answers);
  return answers ? { action: 'submit', answers } : undefined;
};

const toAskUserUiPart = (part: Record<string, unknown>, completedAskToolCallIds: ReadonlySet<string>) => {
  const data = isRecord(part.data) ? part.data : part;
  const isNormalized = part.type === 'data-ask-user';
  if (!isNormalized && data.toolName !== askUserToolName) return null;

  const suspendPayload = isRecord(data.suspendPayload) ? data.suspendPayload : undefined;
  const questions = normalizeAskUserQuestions(isNormalized ? data.questions : suspendPayload?.questions);
  const mastraRunId = nonEmptyString(data.mastraRunId) ?? nonEmptyString(data.runId);
  const toolCallId = nonEmptyString(data.toolCallId);
  if (!mastraRunId || !toolCallId || !questions) return null;
  const requestedAt = nonEmptyString(data.requestedAt) ?? nonEmptyString(suspendPayload?.requestedAt);
  const resume = normalizeAskUserResume(data.resume);

  return {
    type: 'data-ask-user',
    data: {
      mastraRunId,
      toolCallId,
      toolName: askUserToolName,
      questions,
      status: completedAskToolCallIds.has(toolCallId) ? 'submitted' : nonEmptyString(data.status) ?? 'pending',
      ...(resume ? { resume } : {}),
      ...(requestedAt ? { requestedAt } : {}),
    },
  };
};

const toPersistedAskUserToolPart = (
  part: Record<string, unknown>,
  messageId: string,
  partIndex: number,
  completedAskToolCallIds: ReadonlySet<string>,
  suspendedAskUserRunIds: Readonly<Record<string, string>>,
) => {
  if (getToolName(part) !== askUserToolName) return null;

  const toolCallId = getToolCallId(part, messageId, partIndex, askUserToolName);
  const mastraRunId = nonEmptyString(suspendedAskUserRunIds[toolCallId]);
  const questions = normalizeAskUserQuestions((getToolArgs(part) as Record<string, unknown> | undefined)?.questions);
  const resume = normalizeAskUserResume(getToolResult(part));
  if (!mastraRunId || !questions) return null;

  return {
    type: 'data-ask-user',
    data: {
      mastraRunId,
      toolCallId,
      toolName: askUserToolName,
      questions,
      status: resume || completedAskToolCallIds.has(toolCallId) ? 'submitted' : 'pending',
      ...(resume ? { resume } : {}),
    },
  };
};

const collectCompletedAskToolCallIds = (messages: MastraDBMessage[]) => {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const part of message.content.parts) {
      if (!isRecord(part)) continue;
      const record = part as Record<string, unknown>;
      if (getToolName(record) !== askUserToolName || getToolResult(record) === undefined) continue;
      const id = typeof getToolInvocation(record)?.toolCallId === 'string'
        ? getToolInvocation(record)!.toolCallId as string
        : typeof record.toolCallId === 'string'
        ? record.toolCallId
        : undefined;
      if (id) ids.add(id);
    }
  }
  return ids;
};

const absoluteAttachmentUrl = (url: string, origin: string) => {
  const attachmentId = attachmentIdFromReference(url);
  if (attachmentId) return `${origin}${attachmentUrlPath(attachmentId)}`;
  if (/^https?:\/\//i.test(url) || url.startsWith('data:') || url.startsWith('blob:')) return url;
  if (!url.startsWith('/')) return url;
  return `${origin}${url}`;
};

const toUiPart = (
  part: MastraDBMessage['content']['parts'][number],
  origin: string,
  messageId: string,
  partIndex: number,
  completedAskToolCallIds: ReadonlySet<string> = new Set(),
  suspendedAskUserRunIds: Readonly<Record<string, string>> = {},
) => {
  if (isCompactToolHistoryTextPart(part)) return null;

  if (part.type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
    return { type: 'text', text: (part as { text: string }).text };
  }

  if (part.type === 'file') {
    const record = part as Record<string, unknown>;
    const metadata = record.metadata && typeof record.metadata === 'object'
      ? record.metadata as Record<string, unknown>
      : {};
    const metadataUrl = typeof metadata.attachmentUrlPath === 'string' ? metadata.attachmentUrlPath : undefined;
    const recordUrl = typeof record.url === 'string' ? record.url : undefined;
    const dataUrl = typeof record.data === 'string' && record.data.startsWith('data:') ? record.data : undefined;
    const url = metadataUrl ?? recordUrl ?? dataUrl;
    const mediaType = typeof record.mediaType === 'string'
      ? record.mediaType
      : typeof record.mimeType === 'string'
      ? record.mimeType
      : undefined;

    if (url && mediaType?.startsWith('image/')) {
      return {
        type: 'file',
        url: absoluteAttachmentUrl(url, origin),
        mediaType,
        ...(typeof record.filename === 'string' ? { filename: record.filename } : {}),
      };
    }

    return null;
  }

  if (part.type === 'reasoning') {
    const record = part as Record<string, unknown>;
    const details = Array.isArray(record.details) ? record.details : [];
    const text = details
      .map((detail) => typeof detail === 'object' && detail !== null ? (detail as { text?: unknown }).text : undefined)
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n\n')
      .trim();
    const fallback = typeof record.reasoning === 'string' ? record.reasoning.trim() : '';
    const reasoning = text || fallback;

    return reasoning ? { type: 'reasoning', text: reasoning } : null;
  }

  const record = part as Record<string, unknown>;
  const askUserPart = typeof record.type === 'string' && record.type.startsWith('data-')
    ? toAskUserUiPart(record, completedAskToolCallIds)
    : null;
  if (askUserPart) return askUserPart;

  const persistedAskUserPart = toPersistedAskUserToolPart(
    record,
    messageId,
    partIndex,
    completedAskToolCallIds,
    suspendedAskUserRunIds,
  );
  if (persistedAskUserPart) return persistedAskUserPart;

  const hasToolData = record.type === 'tool-call' ||
    (typeof part.type === 'string' && part.type.startsWith('tool-')) ||
    typeof record.toolCallId === 'string' ||
    typeof record.toolName === 'string';

  if (!hasToolData) return null;

  const toolName = getToolName(record);
  const result = getToolResult(record);
  const isError = Boolean(record.isError);

  return {
    type: `tool-${toolName}`,
    toolCallId: getToolCallId(record, messageId, partIndex, toolName),
    state: result === undefined ? 'input-available' : isError ? 'output-error' : 'output-available',
    input: getToolArgs(record),
    output: result,
    errorText: isError ? (typeof result === 'string' ? result : JSON.stringify(result)) : undefined,
  };
};

const toUiAttachmentPart = (attachment: unknown, origin: string) => {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const url = typeof record.url === 'string' ? record.url : undefined;
  const mediaType = typeof record.contentType === 'string' ? record.contentType : undefined;
  if (!url || !mediaType?.startsWith('image/')) return null;

  const attachmentId = attachmentIdFromReference(url);
  return {
    type: 'file',
    url: absoluteAttachmentUrl(url, origin),
    mediaType,
    ...(attachmentId ? { metadata: { attachmentId, attachmentUrlPath: attachmentUrlPath(attachmentId) } } : {}),
  };
};

type UiChatMessage = {
  id: string;
  role: string;
  parts: Array<Record<string, unknown>>;
  status?: { type: string };
  metadata?: unknown;
};

const getPendingMessageText = (message: UiChatMessage) =>
  message.parts
    .map((part) => part.type === 'text' && typeof part.text === 'string' ? part.text : '')
    .join('')
    .trim();

const getPendingAttachmentSignature = (message: UiChatMessage) =>
  message.parts
    .filter((part) => part.type === 'file')
    .map((part) =>
      `${typeof part.url === 'string' ? part.url : ''}:${typeof part.mediaType === 'string' ? part.mediaType : ''}`
    )
    .sort()
    .join('|');

const getPendingMessageSignature = (message: UiChatMessage) =>
  `${message.role}:${getPendingMessageText(message)}:${getPendingAttachmentSignature(message)}`;

const normalizeAskUserResponseText = (value: string) => value.replace(/\s+/g, ' ').trim();

const getAskUserResponseMetadata = (metadata: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(metadata)) return undefined;
  if (isRecord(metadata.askUserResponse)) return metadata.askUserResponse;
  return isRecord(metadata.custom) && isRecord(metadata.custom.askUserResponse)
    ? metadata.custom.askUserResponse
    : undefined;
};

const getAskUserResponseToolCallId = (message: UiChatMessage) =>
  nonEmptyString(getAskUserResponseMetadata(message.metadata)?.toolCallId);

const getAskUserPartData = (part: Record<string, unknown>) =>
  part.type === 'data-ask-user' && isRecord(part.data) ? part.data : undefined;

const getAskUserResponseTextFromPart = (part: Record<string, unknown>) => {
  const data = getAskUserPartData(part);
  if (!data || !isRecord(data.resume)) return undefined;
  if (data.resume.action !== 'submit') return undefined;

  const questions = Array.isArray(data.questions) ? data.questions : [];
  const answers = normalizeAskUserAnswers(data.resume.answers);
  if (!answers) return undefined;

  const lines = answers.map((answer) => {
    const question = questions.find((item) => isRecord(item) && item.id === answer.id);
    const prefix = isRecord(question)
      ? nonEmptyString(question.header) ?? nonEmptyString(question.question) ?? String(answer.id)
      : String(answer.id);
    return `${prefix}: ${String(answer.finalAnswer)}`;
  });

  return normalizeAskUserResponseText(lines.join('\n'));
};

const getCompletedAskUserToolCallIds = (messages: UiChatMessage[]) => {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      const data = getAskUserPartData(part);
      if (data?.status === 'submitted' && nonEmptyString(data.toolCallId)) ids.add(nonEmptyString(data.toolCallId)!);
    }
  }
  return ids;
};

const getAskUserResponseTextSignatures = (messages: UiChatMessage[]) => {
  const signatures = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      const signature = getAskUserResponseTextFromPart(part);
      if (signature) signatures.add(signature);
    }
  }
  return signatures;
};

const findAskUserMessageIndex = (messages: UiChatMessage[], toolCallId: string) =>
  messages.findIndex(message =>
    message.parts.some(part => getAskUserPartData(part)?.toolCallId === toolCallId)
  );

const mergePendingSubmittedMessages = (messages: UiChatMessage[], pendingMessages: UiChatMessage[]) => {
  if (pendingMessages.length === 0) return messages;

  const existingIds = new Set(messages.map((message) => message.id));
  const existingSignatures = new Set(messages.map(getPendingMessageSignature));
  const merged = [...messages];

  for (const pendingMessage of pendingMessages) {
    const signature = getPendingMessageSignature(pendingMessage);
    const askToolCallId = getAskUserResponseToolCallId(pendingMessage);
    const completedAskToolCallIds = getCompletedAskUserToolCallIds(merged);
    const askResponseTextSignatures = getAskUserResponseTextSignatures(merged);

    if (existingIds.has(pendingMessage.id) || existingSignatures.has(signature)) continue;
    if (askToolCallId && completedAskToolCallIds.has(askToolCallId)) continue;
    if (askResponseTextSignatures.has(normalizeAskUserResponseText(getPendingMessageText(pendingMessage)))) continue;

    if (askToolCallId) {
      const askMessageIndex = findAskUserMessageIndex(merged, askToolCallId);
      if (askMessageIndex >= 0) {
        merged.splice(askMessageIndex + 1, 0, pendingMessage);
        existingIds.add(pendingMessage.id);
        existingSignatures.add(signature);
        continue;
      }
    }

    merged.push(pendingMessage);
    existingIds.add(pendingMessage.id);
    existingSignatures.add(signature);
  }

  return merged;
};

const isUiToolPart = (part: Record<string, unknown>) => {
  if (part.type === 'tool-call' || part.type === 'dynamic-tool') return true;
  return typeof part.type === 'string' &&
    part.type.startsWith('tool-') &&
    !['tool-call', 'tool-invocation', 'tool-result'].includes(part.type);
};

const getUiTextPartText = (part: Record<string, unknown>) =>
  part.type === 'text' && typeof part.text === 'string' ? part.text.trim() : '';

const getUiReasoningPartText = (part: Record<string, unknown>) =>
  part.type === 'reasoning' && typeof part.text === 'string' ? part.text.trim() : '';

const isVisibleUiDataPart = (part: Record<string, unknown>) =>
  part.type === 'data-ask-user' ||
  part.type === 'data-user-message' ||
  (part.type === 'data' && (part.name === 'ask-user' || part.name === 'user-message'));

const normalizeStructureText = (value: string) => value.replace(/\s+/g, ' ').trim();

const getAssistantStructureStats = (messages: UiChatMessage[]) => {
  let assistantMessages = 0;
  let visibleParts = 0;
  let toolParts = 0;
  const textParts: string[] = [];

  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    assistantMessages += 1;

    for (const part of message.parts) {
      if (isUiToolPart(part)) {
        toolParts += 1;
        visibleParts += 1;
        continue;
      }

      const text = getUiTextPartText(part) || getUiReasoningPartText(part);
      if (text) {
        visibleParts += 1;
        textParts.push(text);
        continue;
      }

      if (isVisibleUiDataPart(part)) visibleParts += 1;
    }
  }

  return {
    assistantMessages,
    visibleParts,
    toolParts,
    text: normalizeStructureText(textParts.join(' ')),
  };
};

const findLastAssistantMessageIndex = (messages: UiChatMessage[]) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant') return index;
  }
  return -1;
};

const hasCompatibleAssistantText = (persistedText: string, retainedText: string) =>
  !persistedText || !retainedText || persistedText.includes(retainedText) || retainedText.includes(persistedText);

const mergeRetainedRunMessages = (persistedMessages: UiChatMessage[], retainedRunMessages: UiChatMessage[]) => {
  if (retainedRunMessages.length === 0) return persistedMessages;
  if (retainedRunMessages.some(message => message.status?.type === 'running')) return persistedMessages;
  if (retainedRunMessages.some(message => message.role !== 'assistant')) return persistedMessages;

  const lastAssistantIndex = findLastAssistantMessageIndex(persistedMessages);
  if (lastAssistantIndex < 0) return persistedMessages;

  const persistedTail = persistedMessages.slice(lastAssistantIndex);
  if (persistedTail.some(message => message.role !== 'assistant')) return persistedMessages;

  const persistedStats = getAssistantStructureStats(persistedTail);
  const retainedStats = getAssistantStructureStats(retainedRunMessages);
  const retainedIsRicher =
    retainedStats.toolParts > persistedStats.toolParts ||
    retainedStats.visibleParts > persistedStats.visibleParts ||
    retainedStats.assistantMessages > persistedStats.assistantMessages;

  if (retainedStats.toolParts === 0 || !retainedIsRicher) return persistedMessages;
  if (!hasCompatibleAssistantText(persistedStats.text, retainedStats.text)) return persistedMessages;

  return [
    ...persistedMessages.slice(0, lastAssistantIndex),
    ...retainedRunMessages,
  ];
};

const toPendingSubmittedMessage = (message: unknown, origin: string, index: number): UiChatMessage | null => {
  if (!message || typeof message !== 'object') return null;

  const record = message as Record<string, unknown>;
  if (record.role !== 'user') return null;

  const messageId = typeof record.id === 'string' && record.id.trim() ? record.id : `pending-user-${index}`;
  const metadata = record.metadata as Record<string, unknown> | undefined;
  const originalText = typeof metadata?.slashCommandOriginalText === 'string'
    ? metadata.slashCommandOriginalText
    : undefined;
  const attachments = Array.isArray(record.experimental_attachments)
    ? record.experimental_attachments.map((attachment) => toUiAttachmentPart(attachment, origin)).filter((part) =>
      part !== null
    )
    : [];
  const parts = Array.isArray(record.parts)
    ? record.parts.map((part, partIndex) =>
      toUiPart(part as MastraDBMessage['content']['parts'][number], origin, messageId, partIndex)
    ).filter((part) => part !== null)
    : typeof record.content === 'string'
    ? [{ type: 'text', text: record.content }]
    : [];

  return {
    id: messageId,
    role: 'user',
    parts: originalText ? [{ type: 'text', text: originalText }, ...attachments] : [...parts, ...attachments],
    ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
  };
};

const toUiMessage = (
  message: MastraDBMessage,
  origin: string,
  completedAskToolCallIds: ReadonlySet<string> = new Set(),
  suspendedAskUserRunIds: Readonly<Record<string, string>> = {},
) => {
  const metadata = message.content.metadata as Record<string, unknown> | undefined;
  const originalText = message.role === 'user' && typeof metadata?.slashCommandOriginalText === 'string'
    ? metadata.slashCommandOriginalText
    : undefined;
  const attachments = Array.isArray(message.content.experimental_attachments)
    ? message.content.experimental_attachments.map((attachment) => toUiAttachmentPart(attachment, origin)).filter(
      (part) => part !== null,
    )
    : [];

  return {
    id: message.id,
    role: message.role,
    parts: originalText ? [{ type: 'text', text: originalText }, ...attachments] : [
      ...message.content.parts.map((part, index) =>
        toUiPart(part, origin, message.id, index, completedAskToolCallIds, suspendedAskUserRunIds)
      ).filter((part) => part !== null),
      ...attachments,
    ],
    status: message.role === 'assistant' ? { type: 'complete' } : undefined,
    metadata: message.content.metadata,
  } satisfies UiChatMessage;
};

const getResourceId = (c: any) => {
  const resourceId = c.get('requestContext')?.get(MASTRA_RESOURCE_ID_KEY);
  if (typeof resourceId !== 'string' || !resourceId) throw new Error('Authenticated resource missing');
  return resourceId;
};

const errorResponse = (c: any, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const status = typeof (error as { status?: unknown })?.status === 'number'
    ? (error as { status: number }).status
    : 500;
  console.error('[chat-state]', error);
  const details = isRecord((error as { details?: unknown })?.details)
    ? (error as { details: Record<string, unknown> }).details
    : undefined;
  return c.json({ error: message, ...(details ?? {}) }, status);
};

const unwiredAgentService = new Proxy({}, {
  get(_target, prop) {
    throw new Error(`Chat state route "${String(prop)}" requires an injected AgentService`);
  },
}) as AgentService;

export const createChatStateRoutes = (service: AgentService) => [
  defineRoute('/owner/me', {
    method: 'GET',
    handler: async (c) => {
      try {
        const user = getAuthUserFromHeader(c.req.header('Authorization'));
        if (!user) return c.json({ error: 'Unauthorized' }, 401);

        return c.json({ user: { id: user.id, name: user.name } });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/chat/threads', {
    method: 'GET',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);

        return c.json({ threads: await service.listChatThreads({ resourceId }) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/chat/threads', {
    method: 'POST',
    handler: async (c) => {
      try {
        const body = await c.req.json();
        const resourceId = getResourceId(c);
        const threadId = body?.threadId;
        const title = body?.title ?? '...';
        const projectId = typeof body?.projectId === 'string' ? body.projectId : undefined;
        const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : undefined;

        const thread = await service.createChatThread({
          resourceId,
          threadId,
          title,
          projectId,
          workspaceId,
        });

        return c.json({ thread });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/chat/threads/reorder', {
    method: 'PATCH',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const body = await c.req.json();
        const threadIds = Array.isArray(body?.threadIds)
          ? body.threadIds.filter((id: unknown) => typeof id === 'string')
          : [];
        const scope = body?.scope as Record<string, unknown> | undefined;
        const scopeProjectId = typeof scope?.projectId === 'string' ? scope.projectId : undefined;
        const scopeWorkspaceId = typeof scope?.workspaceId === 'string' ? scope.workspaceId : undefined;
        const plain = scope?.plain === true;

        await service.reorderChatThreads({
          resourceId,
          threadIds,
          scope: {
            ...(scopeProjectId ? { projectId: scopeProjectId } : {}),
            ...(scopeWorkspaceId ? { workspaceId: scopeWorkspaceId } : {}),
            ...(plain ? { plain } : {}),
          },
        });

        return c.json({ ok: true });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/chat/threads/:threadId/raw-messages', {
    method: 'GET',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const threadId = c.req.param('threadId');

        return c.json({ messages: await service.getChatThreadRawMessages({ resourceId, threadId }) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/chat/threads/:threadId/context-usage', {
    method: 'GET',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const threadId = c.req.param('threadId');
        const modelId = nonEmptyString(c.req.query('model'));
        if (!modelId) return c.json({ error: 'model is required' }, 400);

        return c.json(
          await service.getChatThreadContextUsage({
            threadId,
            resourceId,
            modelId,
          }),
        );
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/chat/threads/:threadId/compact', {
    method: 'POST',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const threadId = c.req.param('threadId');
        const body = await c.req.json();
        const model = nonEmptyString(body?.model);
        if (!model) return c.json({ error: 'model is required' }, 400);
        const result = await service.compactChatThread({
          resourceId,
          threadId,
          model,
          instructions: nonEmptyString(body?.instructions),
          abortSignal: c.req.raw.signal,
        });
        return c.json(result);
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/chat/threads/:threadId/messages', {
    method: 'GET',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const threadId = c.req.param('threadId');

        const origin = new URL(c.req.url).origin;
        const [rawMessages, suspendedAskUserRunIds, compactions] = await Promise.all([
          service.getChatThreadMessages({ resourceId, threadId }),
          service.getChatSuspendedAskUserRunIds({ resourceId, threadId }),
          service.listChatThreadCompactions({ resourceId, threadId }),
        ]);
        const completedAskToolCallIds = collectCompletedAskToolCallIds(rawMessages);
        const persistedMessages: UiChatMessage[] = rawMessages
          .map((message: MastraDBMessage) =>
            toUiMessage(message, origin, completedAskToolCallIds, suspendedAskUserRunIds)
          );
        for (const checkpoint of compactions) {
          const marker = threadCompactionDisplayMessage(checkpoint) as UiChatMessage;
          const index = persistedMessages.findIndex(message => message.id === checkpoint.compactedThroughMessageId);
          persistedMessages.splice(index < 0 ? persistedMessages.length : index + 1, 0, marker);
        }
        const pendingMessages = service.getChatSubmittedUserMessages(resourceId, threadId)
          .map((message, index) => toPendingSubmittedMessage(message, origin, index))
          .filter((message): message is UiChatMessage => message !== null);
        const retainedRunMessages = service.getChatUiMessages(resourceId, threadId) as UiChatMessage[];
        const messagesWithRetainedRun = mergeRetainedRunMessages(persistedMessages, retainedRunMessages);
        const retainedRunMerged = messagesWithRetainedRun !== persistedMessages;
        const shouldAppendRunMessages = retainedRunMessages.length > 0 && !retainedRunMerged &&
          (pendingMessages.length > 0 || messagesWithRetainedRun[messagesWithRetainedRun.length - 1]?.role !== 'assistant');

        return c.json({
          messages: mergePendingSubmittedMessages(
            messagesWithRetainedRun,
            shouldAppendRunMessages ? [...pendingMessages, ...retainedRunMessages] : pendingMessages,
          ),
        });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/chat/threads/:threadId', {
    method: 'PATCH',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const threadId = c.req.param('threadId');
        const body = await c.req.json();
        const title = typeof body?.title === 'string' ? body.title.trim() : '';
        const hasArchived = typeof body?.archived === 'boolean';
        if (!title && !hasArchived) return c.json({ error: 'title or archived is required' }, 400);

        const thread = await service.updateChatThread({
          resourceId,
          threadId,
          ...(title ? { title } : {}),
          ...(hasArchived ? { archived: body.archived } : {}),
        });

        return c.json({ thread });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/chat/threads/:threadId', {
    method: 'DELETE',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const threadId = c.req.param('threadId');

        await service.deleteChatThread({ resourceId, threadId });
        return c.json({ ok: true });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
];

export const chatStateRoutes = createChatStateRoutes(unwiredAgentService);

export const __chatStateContextUsageTest = {
  contextUsageRecallOptions,
  estimateContextTokens,
  estimateMemoryContextTokens,
  toUiMessage,
  collectCompletedAskToolCallIds,
  toPendingSubmittedMessage,
  mergePendingSubmittedMessages,
  mergeRetainedRunMessages,
};
