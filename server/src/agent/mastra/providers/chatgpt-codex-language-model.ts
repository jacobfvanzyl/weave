import { Buffer } from 'node:buffer';
import { createOpenAI } from '@ai-sdk/openai';
import {
  attachmentIdFromReference,
  type AttachmentStorage,
  attachmentStorage,
} from '../../../modules/attachments/storage';
import { contextUsageFromProviderUsage, recordThreadContextUsage } from '../context-usage';
import { type CodexCredentials, getCodexCredentials } from './chatgpt-codex-auth';

export const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

type OpenAIResponsesModel = ReturnType<ReturnType<typeof createOpenAI>['responses']>;
type GenerateOptions = Parameters<OpenAIResponsesModel['doGenerate']>[0];
type GenerateResult = Awaited<ReturnType<OpenAIResponsesModel['doGenerate']>>;
type StreamOptions = Parameters<OpenAIResponsesModel['doStream']>[0];
type StreamResult = Awaited<ReturnType<OpenAIResponsesModel['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never;
type ProviderUsage = GenerateResult['usage'] | Extract<StreamPart, { type: 'finish' }>['usage'];
type GetCodexCredentials = () => Promise<CodexCredentials>;
type FetchFunction = typeof fetch;
type RecordUsage = typeof recordThreadContextUsage;
type AttachmentReader = Pick<AttachmentStorage, 'get'>;

type ContextUsageTracking = {
  threadId: string;
  resourceId?: string;
  maxTokens?: number;
};

const placeholderApiKey = 'chatgpt-subscription';

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' ? value as Record<string, unknown> : undefined;

const getContextUsageTracking = (options: { providerOptions?: unknown }): ContextUsageTracking | undefined => {
  const tracking = asRecord(asRecord(options.providerOptions)?.mastraContextUsage);
  if (!tracking) return undefined;
  const threadId = typeof tracking?.threadId === 'string' ? tracking.threadId : undefined;
  if (!threadId) return undefined;

  return {
    threadId,
    resourceId: typeof tracking.resourceId === 'string' ? tracking.resourceId : undefined,
    maxTokens: typeof tracking.maxTokens === 'number' && Number.isFinite(tracking.maxTokens) && tracking.maxTokens > 0
      ? tracking.maxTokens
      : undefined,
  };
};

const knownToolOutputTypes = new Set([
  'text',
  'json',
  'execution-denied',
  'error-text',
  'error-json',
  'content',
]);

const toJsonValue = (value: unknown) => {
  if (value === undefined) return null;

  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : JSON.parse(serialized);
  } catch {
    return String(value);
  }
};

const stringifyToolOutput = (value: unknown) => {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';

  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
};

const legacyToolOutputFromValue = (value: unknown, isError: boolean) => {
  if (typeof value === 'string') {
    return { type: isError ? 'error-text' : 'text', value };
  }

  if (value === undefined) {
    return { type: isError ? 'error-text' : 'text', value: '' };
  }

  return { type: isError ? 'error-json' : 'json', value: toJsonValue(value) };
};

const normalizeKnownToolOutput = (
  output: Record<string, unknown>,
  fallbackValue: unknown,
  isError: boolean,
) => {
  const type = typeof output.type === 'string' ? output.type : undefined;
  if (!type || !knownToolOutputTypes.has(type)) return undefined;

  switch (type) {
    case 'text':
    case 'error-text':
      return typeof output.value === 'string'
        ? output
        : { ...output, value: stringifyToolOutput(output.value ?? fallbackValue) };
    case 'json':
    case 'error-json':
      return 'value' in output ? output : { ...output, value: toJsonValue(fallbackValue) };
    case 'content':
      return Array.isArray(output.value) ? output : legacyToolOutputFromValue(fallbackValue, isError);
    case 'execution-denied':
      return output;
  }
};

const normalizeToolResultPart = (part: Record<string, unknown>) => {
  if (part.type !== 'tool-result') return part;

  const fallbackValue = 'result' in part ? part.result : undefined;
  const knownOutput = asRecord(part.output);
  const normalizedOutput = knownOutput
    ? normalizeKnownToolOutput(knownOutput, fallbackValue, part.isError === true)
    : undefined;

  return {
    ...part,
    output: normalizedOutput ?? legacyToolOutputFromValue(part.output ?? fallbackValue, part.isError === true),
  };
};

const normalizePromptToolResultOutputs = (prompt: unknown) => {
  if (!Array.isArray(prompt)) return prompt;

  let changed = false;
  const normalizedPrompt = prompt.map((message) => {
    const record = asRecord(message);
    const content = Array.isArray(record?.content) ? record.content : undefined;
    if (!record || !content) return message;

    let messageChanged = false;
    const normalizedContent = content.map((part) => {
      const partRecord = asRecord(part);
      if (!partRecord || partRecord.type !== 'tool-result') return part;

      const normalizedPart = normalizeToolResultPart(partRecord);
      if (normalizedPart !== partRecord) {
        changed = true;
        messageChanged = true;
      }
      return normalizedPart;
    });

    return messageChanged ? { ...record, content: normalizedContent } : message;
  });

  return changed ? normalizedPrompt : prompt;
};

const recordContextUsage = (options: { providerOptions?: unknown }, usage: ProviderUsage, recordUsage: RecordUsage) => {
  const tracking = getContextUsageTracking(options);
  if (!tracking) return;

  const contextUsage = contextUsageFromProviderUsage(usage);
  if (!contextUsage) return;

  recordUsage({
    ...tracking,
    ...contextUsage,
  });
};

const withSubscriptionRequiredOptions = <Options extends { providerOptions?: unknown; prompt?: unknown }>(
  options: Options,
): Options => {
  const providerOptions = asRecord(options.providerOptions) ?? {};
  const openaiOptions = asRecord(providerOptions.openai) ?? {};
  const prompt = normalizePromptToolResultOutputs(options.prompt);

  return {
    ...options,
    ...(prompt !== options.prompt ? { prompt } : {}),
    providerOptions: {
      ...providerOptions,
      openai: {
        ...openaiOptions,
        store: false,
      },
    },
  };
};

const inlineLocalAttachmentImages = async (value: unknown, storage: AttachmentReader): Promise<boolean> => {
  if (Array.isArray(value)) {
    let changed = false;
    for (const item of value) changed ||= await inlineLocalAttachmentImages(item, storage);
    return changed;
  }

  const record = asRecord(value);
  if (!record) return false;

  let changed = false;
  if (record.type === 'input_image' && typeof record.image_url === 'string') {
    const attachmentId = attachmentIdFromReference(record.image_url);
    if (attachmentId) {
      const attachment = await storage.get(attachmentId);
      if (attachment) {
        record.image_url = `data:${attachment.mimeType};base64,${Buffer.from(attachment.bytes).toString('base64')}`;
        changed = true;
      }
    }
  }

  for (const item of Object.values(record)) changed ||= await inlineLocalAttachmentImages(item, storage);
  return changed;
};

const inlineLocalAttachmentsInBody = async (
  body: BodyInit | null | undefined,
  storage: AttachmentReader,
): Promise<BodyInit | null | undefined> => {
  if (typeof body !== 'string') return body;

  try {
    const parsed = JSON.parse(body) as unknown;
    const changed = await inlineLocalAttachmentImages(parsed, storage);
    return changed ? JSON.stringify(parsed) : body;
  } catch {
    return body;
  }
};

export const createChatGPTCodexFetch = ({
  fetch: innerFetch = fetch,
  getCredentials = getCodexCredentials,
  attachments = attachmentStorage,
}: {
  fetch?: FetchFunction;
  getCredentials?: GetCodexCredentials;
  attachments?: AttachmentReader;
} = {}): FetchFunction => {
  return async (input, init) => {
    const credentials = await getCredentials();
    const headers = new Headers(init?.headers);
    const body = await inlineLocalAttachmentsInBody(init?.body, attachments);

    headers.set('Authorization', `Bearer ${credentials.access}`);
    headers.set('ChatGPT-Account-Id', credentials.accountId ?? '');
    headers.set('originator', 'mage-hand');
    headers.set('User-Agent', 'mage-hand');
    headers.set('OpenAI-Beta', 'responses=experimental');

    return innerFetch(input, {
      ...init,
      headers,
      body,
    });
  };
};

export type ChatGPTCodexLanguageModelOptions = {
  modelId: string;
  headers?: Record<string, string>;
  fetch?: FetchFunction;
  getCredentials?: GetCodexCredentials;
  attachments?: AttachmentReader;
  recordUsage?: RecordUsage;
};

export class ChatGPTCodexLanguageModel {
  readonly specificationVersion = 'v3' as const;
  readonly modelId: string;

  readonly #model: OpenAIResponsesModel;
  readonly #recordUsage: RecordUsage;

  constructor({
    modelId,
    headers,
    fetch: innerFetch,
    getCredentials,
    attachments,
    recordUsage = recordThreadContextUsage,
  }: ChatGPTCodexLanguageModelOptions) {
    this.modelId = modelId;
    this.#recordUsage = recordUsage;
    this.#model = createOpenAI({
      apiKey: placeholderApiKey,
      baseURL: CHATGPT_CODEX_BASE_URL,
      headers,
      fetch: createChatGPTCodexFetch({ fetch: innerFetch, getCredentials, attachments }),
    }).responses(modelId);
  }

  get provider() {
    return this.#model.provider;
  }

  get supportedUrls() {
    return this.#model.supportedUrls;
  }

  async doGenerate(options: GenerateOptions): Promise<GenerateResult> {
    const requestOptions = withSubscriptionRequiredOptions(options);
    const result = await this.#model.doGenerate(requestOptions);
    recordContextUsage(requestOptions, result.usage, this.#recordUsage);
    return result;
  }

  async doStream(options: StreamOptions): Promise<StreamResult> {
    const requestOptions = withSubscriptionRequiredOptions(options);
    const result = await this.#model.doStream(requestOptions);
    const recordUsage = this.#recordUsage;

    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream<StreamPart, StreamPart>({
          transform(chunk, controller) {
            if (chunk.type === 'finish') recordContextUsage(requestOptions, chunk.usage, recordUsage);
            controller.enqueue(chunk);
          },
        }),
      ),
    };
  }
}

type TestCodexStreamPart =
  | { type: 'stream-start' }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'reasoning-start'; id: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'reasoning-end'; id: string }
  | { type: 'tool-input-start'; id: string; toolName: string }
  | { type: 'tool-input-delta'; id: string; delta: string }
  | { type: 'tool-input-end'; id: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
  | { type: 'finish'; finishReason: 'stop'; usage: { totalTokens: number } }
  | { type: 'error'; error: Error };

type TestCodexToolCallState = {
  callId: string;
  toolName: string;
  input: string;
};

const getStringField = (record: Record<string, unknown> | undefined, key: string): string | undefined =>
  typeof record?.[key] === 'string' ? record[key] : undefined;

const getNumberField = (record: Record<string, unknown> | undefined, key: string): number | undefined =>
  typeof record?.[key] === 'number' && Number.isFinite(record[key]) ? record[key] : undefined;

const testTextId = (itemId: string, contentIndex: number) => `text-${itemId}-${contentIndex}`;
const testReasoningSummaryId = (itemId: string, summaryIndex: number) =>
  `reasoning-summary-${itemId}-${summaryIndex}`;

const collectCodexResponseStreamParts = async (
  events: Array<Record<string, unknown>>,
): Promise<TestCodexStreamPart[]> => {
  const parts: TestCodexStreamPart[] = [{ type: 'stream-start' }];
  const openTextIds = new Set<string>();
  const itemTextIds = new Map<string, Set<string>>();
  const openReasoningIds = new Set<string>();
  const endedReasoningIds = new Set<string>();
  const toolCallsByItemId = new Map<string, TestCodexToolCallState>();
  const openToolInputIds = new Set<string>();
  let sawTerminalEvent = false;

  const addItemTextId = (itemId: string, textId: string) => {
    const ids = itemTextIds.get(itemId) ?? new Set<string>();
    ids.add(textId);
    itemTextIds.set(itemId, ids);
  };

  const startText = (itemId: string, contentIndex: number) => {
    const id = testTextId(itemId, contentIndex);
    if (!openTextIds.has(id)) {
      openTextIds.add(id);
      addItemTextId(itemId, id);
      parts.push({ type: 'text-start', id });
    }
    return id;
  };

  const endText = (id: string) => {
    if (!openTextIds.delete(id)) return;
    parts.push({ type: 'text-end', id });
  };

  const endTextForItem = (itemId: string) => {
    const ids = itemTextIds.get(itemId);
    if (!ids) return;
    for (const id of ids) endText(id);
    itemTextIds.delete(itemId);
  };

  const startReasoning = (id: string) => {
    if (endedReasoningIds.has(id) || openReasoningIds.has(id)) return false;
    openReasoningIds.add(id);
    parts.push({ type: 'reasoning-start', id });
    return true;
  };

  const addReasoningDelta = (itemId: string, summaryIndex: number, delta: string) => {
    const id = testReasoningSummaryId(itemId, summaryIndex);
    if (endedReasoningIds.has(id)) return;
    startReasoning(id);
    if (delta) parts.push({ type: 'reasoning-delta', id, delta });
  };

  const endReasoning = (itemId: string, summaryIndex: number, text?: string) => {
    const id = testReasoningSummaryId(itemId, summaryIndex);
    if (endedReasoningIds.has(id)) return;

    if (!openReasoningIds.has(id)) {
      startReasoning(id);
      if (text) parts.push({ type: 'reasoning-delta', id, delta: text });
    }

    openReasoningIds.delete(id);
    endedReasoningIds.add(id);
    parts.push({ type: 'reasoning-end', id });
  };

  const startToolInput = (itemId: string, item: Record<string, unknown>) => {
    const callId = getStringField(item, 'call_id') ?? itemId;
    const toolName = getStringField(item, 'name') ?? '';
    toolCallsByItemId.set(itemId, { callId, toolName, input: '' });
    if (!openToolInputIds.has(callId)) {
      openToolInputIds.add(callId);
      parts.push({ type: 'tool-input-start', id: callId, toolName });
    }
  };

  const addToolInputDelta = (itemId: string, delta: string) => {
    const toolCall = toolCallsByItemId.get(itemId);
    if (!toolCall) return;
    toolCall.input += delta;
    if (delta) parts.push({ type: 'tool-input-delta', id: toolCall.callId, delta });
  };

  const finishToolCall = (itemId: string, item: Record<string, unknown>) => {
    const toolCall = toolCallsByItemId.get(itemId) ?? {
      callId: getStringField(item, 'call_id') ?? itemId,
      toolName: getStringField(item, 'name') ?? '',
      input: '',
    };
    const input = getStringField(item, 'arguments') ?? toolCall.input;
    if (openToolInputIds.delete(toolCall.callId)) {
      parts.push({ type: 'tool-input-end', id: toolCall.callId });
    }
    parts.push({ type: 'tool-call', toolCallId: toolCall.callId, toolName: toolCall.toolName, input });
    toolCallsByItemId.delete(itemId);
  };

  const closeOpenParts = () => {
    for (const id of [...openTextIds]) endText(id);
    itemTextIds.clear();
    for (const id of [...openReasoningIds]) {
      openReasoningIds.delete(id);
      endedReasoningIds.add(id);
      parts.push({ type: 'reasoning-end', id });
    }
    for (const id of [...openToolInputIds]) {
      openToolInputIds.delete(id);
      parts.push({ type: 'tool-input-end', id });
    }
  };

  for (const event of events) {
    const eventType = getStringField(event, 'type');
    const item = asRecord(event.item);

    switch (eventType) {
      case 'response.output_item.added': {
        const itemId = getStringField(item, 'id');
        if (itemId && item?.type === 'function_call') startToolInput(itemId, item);
        break;
      }
      case 'response.output_text.delta': {
        const itemId = getStringField(event, 'item_id');
        const contentIndex = getNumberField(event, 'content_index') ?? 0;
        const delta = getStringField(event, 'delta') ?? '';
        if (!itemId) break;
        const id = startText(itemId, contentIndex);
        if (delta) parts.push({ type: 'text-delta', id, delta });
        break;
      }
      case 'response.reasoning_summary_text.delta': {
        const itemId = getStringField(event, 'item_id');
        const summaryIndex = getNumberField(event, 'summary_index') ?? 0;
        const delta = getStringField(event, 'delta') ?? '';
        if (itemId) addReasoningDelta(itemId, summaryIndex, delta);
        break;
      }
      case 'response.reasoning_summary_part.done': {
        const itemId = getStringField(event, 'item_id');
        const summaryIndex = getNumberField(event, 'summary_index') ?? 0;
        const part = asRecord(event.part);
        const text = getStringField(part, 'text');
        if (itemId) endReasoning(itemId, summaryIndex, text);
        break;
      }
      case 'response.reasoning_summary_text.done': {
        const itemId = getStringField(event, 'item_id');
        const summaryIndex = getNumberField(event, 'summary_index') ?? 0;
        const text = getStringField(event, 'text');
        if (itemId) endReasoning(itemId, summaryIndex, text);
        break;
      }
      case 'response.function_call_arguments.delta': {
        const itemId = getStringField(event, 'item_id');
        const delta = getStringField(event, 'delta') ?? '';
        if (itemId) addToolInputDelta(itemId, delta);
        break;
      }
      case 'response.output_item.done': {
        const itemId = getStringField(item, 'id');
        if (!itemId || !item) break;
        if (item.type === 'message') endTextForItem(itemId);
        if (item.type === 'function_call') finishToolCall(itemId, item);
        break;
      }
      case 'response.completed': {
        const response = asRecord(event.response);
        const usage = asRecord(response?.usage);
        closeOpenParts();
        parts.push({
          type: 'finish',
          finishReason: 'stop',
          usage: { totalTokens: getNumberField(usage, 'total_tokens') ?? 0 },
        });
        sawTerminalEvent = true;
        break;
      }
      case 'response.failed':
      case 'response.error': {
        closeOpenParts();
        parts.push({ type: 'error', error: new Error('ChatGPT Codex response stream failed.') });
        sawTerminalEvent = true;
        break;
      }
    }
  }

  if (!sawTerminalEvent) {
    closeOpenParts();
    parts.push({ type: 'error', error: new Error('ChatGPT Codex response stream ended before a terminal response event.') });
  }

  return parts;
};

export const __chatgptCodexLanguageModelTest = {
  collectCodexResponseStreamParts,
};

export const createChatGPTCodexLanguageModel = (options: ChatGPTCodexLanguageModelOptions) =>
  new ChatGPTCodexLanguageModel(options);
