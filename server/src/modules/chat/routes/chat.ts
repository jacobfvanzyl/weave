import type { AgentMessageInput } from '@mastra/core/agent';
import { AgentRunCoordinator, createAgentRunCoordinatorTestApi } from '../../../agent/run-coordinator';
import type { ResourceService } from '../../../services/resource-service';
import { callerForOwner } from '../../../services/types';
import {
  attachmentIdFromReference,
  attachmentModelUrl,
  attachmentUrlPath,
  type AttachmentPayload,
  type AttachmentStorage,
  parseBase64DataUrl,
  type StoredAttachment,
  type StoredAttachmentMetadata,
} from '../../attachments/storage';

const maxImageAttachmentBytes = 10 * 1024 * 1024;
export const getSubmittedUserMessages = (messages: unknown) => {
  if (!Array.isArray(messages)) return [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Record<string, unknown> | undefined;
    if (message && typeof message === 'object' && message.role === 'user') return [message];
  }

  return [];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type AttachmentNormalizerStorage = Pick<AttachmentStorage, 'findByThread' | 'put'> & {
  get?: AttachmentStorage['get'];
};

const attachmentAccessForNormalization = (
  options: {
    resourceId?: string;
    threadId?: string;
    resources?: Pick<ResourceService, 'findAttachmentsByThread' | 'putAttachment'> &
      Partial<Pick<ResourceService, 'getAttachment'>>;
    storage?: AttachmentNormalizerStorage;
  },
): AttachmentNormalizerStorage => {
  if (options.storage) return options.storage;

  const resources = options.resources;
  if (!resources) {
    return {
      findByThread: async () => [],
      get: async () => null,
      put: async () => {
        throw new Error('Attachment storage is not configured for chat route normalization');
      },
    };
  }

  const caller = callerForOwner(
    options.resourceId ?? 'unknown',
    'ui',
    options.threadId ? { threadId: options.threadId } : undefined,
  );
  return {
    findByThread: (threadId: string): Promise<StoredAttachmentMetadata[]> =>
      resources.findAttachmentsByThread(caller, threadId),
    get: async (id: string) => resources.getAttachment ? resources.getAttachment(caller, id) : null,
    put: (input: AttachmentPayload): Promise<StoredAttachment> => resources.putAttachment(caller, input),
  };
};

export const normalizeMessageImageAttachments = async (
  messages: unknown,
  options: {
    resourceId?: string;
    threadId?: string;
    resources?: Pick<ResourceService, 'findAttachmentsByThread' | 'putAttachment'>;
    storage?: AttachmentNormalizerStorage;
  },
) => {
  if (!Array.isArray(messages)) return messages;
  const storage = attachmentAccessForNormalization(options);
  const threadAttachments = options.threadId ? await storage.findByThread(options.threadId) : [];

  const newestMatchingAttachment = (part: Record<string, unknown>): StoredAttachmentMetadata | undefined => {
    const metadata = part.metadata && typeof part.metadata === 'object' ? part.metadata as Record<string, unknown> : {};
    const attachmentId = typeof metadata.attachmentId === 'string' ? metadata.attachmentId : undefined;
    const filename = typeof part.filename === 'string' ? part.filename : undefined;
    const mediaType = typeof part.mediaType === 'string'
      ? part.mediaType
      : typeof part.mimeType === 'string'
      ? part.mimeType
      : undefined;

    return threadAttachments
      .filter((attachment) =>
        (attachmentId ? attachment.id === attachmentId : true) &&
        (filename ? attachment.originalName === filename : true) &&
        (mediaType ? attachment.mimeType === mediaType.toLowerCase() : true)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  };

  return Promise.all(messages.map(async (message) => {
    if (!message || typeof message !== 'object') return message;
    const record = message as Record<string, unknown>;
    if (!Array.isArray(record.parts)) return message;
    const experimentalAttachments = Array.isArray(record.experimental_attachments)
      ? record.experimental_attachments.filter((attachment) => {
        if (!attachment || typeof attachment !== 'object') return true;
        const attachmentRecord = attachment as Record<string, unknown>;
        const url = typeof attachmentRecord.url === 'string' ? attachmentRecord.url : '';
        return !url.startsWith('data:') && !attachmentIdFromReference(url);
      })
      : [];
    const nextExperimentalAttachments: Array<Record<string, unknown>> = [...experimentalAttachments];

    const parts = await Promise.all(record.parts.map(async (part) => {
      if (!part || typeof part !== 'object') return part;
      const partRecord = part as Record<string, unknown>;
      if (partRecord.type !== 'file') return part;

      const rawData = typeof partRecord.data === 'string' ? partRecord.data : undefined;
      const rawUrl = typeof partRecord.url === 'string' ? partRecord.url : undefined;
      const mediaType = typeof partRecord.mediaType === 'string'
        ? partRecord.mediaType
        : typeof partRecord.mimeType === 'string'
        ? partRecord.mimeType
        : undefined;
      const dataUrl = rawData?.startsWith('data:') ? rawData : rawUrl?.startsWith('data:') ? rawUrl : undefined;
      if (!dataUrl) {
        const referencedAttachmentId = rawUrl
          ? attachmentIdFromReference(rawUrl)
          : rawData
          ? attachmentIdFromReference(rawData)
          : undefined;
        const referenced = referencedAttachmentId && storage.get ? await storage.get(referencedAttachmentId) : null;
        const stored = mediaType?.startsWith('image/')
          ? referencedAttachmentId
            ? referenced
              ? {
                id: referencedAttachmentId,
                urlPath: attachmentUrlPath(referencedAttachmentId),
                mimeType: referenced.mimeType,
                sizeBytes: referenced.sizeBytes,
                originalName: referenced.originalName,
                createdAt: '',
              }
              : threadAttachments.find((attachment) => attachment.id === referencedAttachmentId)
            : newestMatchingAttachment(partRecord)
          : undefined;
        if (!stored) return part;
        nextExperimentalAttachments.push({
          url: attachmentModelUrl(stored.id),
          contentType: stored.mimeType,
        });
        return null;
      }

      const parsed = parseBase64DataUrl(dataUrl);
      if (!parsed || !parsed.mimeType.startsWith('image/')) return part;
      if (parsed.bytes.byteLength > maxImageAttachmentBytes) {
        throw new Error(`Image attachment exceeds the ${maxImageAttachmentBytes} byte limit`);
      }

      const stored = await storage.put({
        bytes: parsed.bytes,
        mimeType: parsed.mimeType,
        originalName: typeof partRecord.filename === 'string' ? partRecord.filename : 'image',
        threadId: options.threadId,
      });

      nextExperimentalAttachments.push({
        url: attachmentModelUrl(stored.id),
        contentType: stored.mimeType,
      });
      return null;
    }));

    return {
      ...record,
      parts: parts.filter((part) => part !== null),
      experimental_attachments: nextExperimentalAttachments.length ? nextExperimentalAttachments : undefined,
    };
  }));
};

const isDisplayOnlySubmittedPart = (part: unknown) => {
  if (!part || typeof part !== 'object') return false;
  const type = (part as Record<string, unknown>).type;
  return typeof type === 'string' &&
    (type === 'reasoning' || type === 'redacted-reasoning' || type.startsWith('data-'));
};

export const sanitizeSubmittedMessagesForMastra = (messages: unknown) => {
  if (!Array.isArray(messages)) return messages;

  return messages
    .map((message) => {
      if (!message || typeof message !== 'object') return message;
      const record = message as Record<string, unknown>;
      if (!Array.isArray(record.parts)) return message;

      const parts = record.parts.filter((part) => !isDisplayOnlySubmittedPart(part));
      if (parts.length === record.parts.length) return message;

      return { ...record, parts };
    })
    .filter((message) => {
      if (!message || typeof message !== 'object') return true;
      const record = message as Record<string, unknown>;
      if (record.role === 'user') return true;
      if (!Array.isArray(record.parts)) return true;
      if (record.parts.length > 0) return true;
      return typeof record.content === 'string' && record.content.trim().length > 0;
    });
};

const latestUserMessageOnly = (messages: unknown) => {
  if (!Array.isArray(messages) || messages.length <= 1) return messages;
  const last = messages[messages.length - 1];
  if (last && typeof last === 'object') {
    const record = last as Record<string, unknown>;
    const hasApprovalResponse = record.role === 'assistant' && Array.isArray(record.parts) &&
      record.parts.some((part) => {
        if (!part || typeof part !== 'object') return false;
        return (part as Record<string, unknown>).state === 'approval-responded';
      });
    if (hasApprovalResponse) return [last];
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Record<string, unknown> | undefined;
    if (message && typeof message === 'object' && message.role === 'user') return [message];
  }
  return [messages[messages.length - 1]];
};

export const submittedMessagesForMemory = (messages: unknown, threadId: unknown) =>
  typeof threadId === 'string' && threadId.trim() ? latestUserMessageOnly(messages) : messages;

export const getString = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined;

const toAgentFileData = (value: string) => {
  try {
    return new URL(value);
  } catch {
    return value;
  }
};

export const toAgentMessageInput = (message: unknown): AgentMessageInput => {
  if (!isRecord(message) || message.role !== 'user') {
    throw new Error('Steering message must be a user message');
  }

  const contents: Array<Record<string, unknown>> = [];
  const addText = (text: unknown) => {
    if (typeof text === 'string' && text.length > 0) contents.push({ type: 'text', text });
  };
  const addFile = (file: Record<string, unknown>) => {
    const mediaType = getString(file.mediaType) ?? getString(file.mimeType) ?? getString(file.contentType);
    const data = getString(file.data) ?? getString(file.url);
    if (!data || !mediaType) return;
    contents.push({
      type: 'file',
      data: toAgentFileData(data),
      mediaType,
      ...(getString(file.filename) ? { filename: getString(file.filename) } : {}),
      ...(file.providerOptions !== undefined ? { providerOptions: file.providerOptions } : {}),
    });
  };

  if (Array.isArray(message.parts)) {
    for (const part of message.parts) {
      if (!isRecord(part)) continue;
      if (part.type === 'text') addText(part.text);
      else if (part.type === 'file') addFile(part);
    }
  } else {
    addText(message.content);
  }

  if (Array.isArray(message.experimental_attachments)) {
    for (const attachment of message.experimental_attachments) {
      if (isRecord(attachment)) addFile(attachment);
    }
  }

  if (contents.length === 0) {
    throw new Error('Steering message must include text or complete attachments');
  }

  return {
    contents,
    ...(isRecord(message.metadata) ? { metadata: message.metadata } : {}),
    ...(isRecord(message.providerOptions) ? { providerOptions: message.providerOptions } : {}),
  } as unknown as AgentMessageInput;
};

export const __chatRouteMemoryTest = {
  latestUserMessageOnly,
  getSubmittedUserMessages,
  normalizeMessageImageAttachments,
  sanitizeSubmittedMessagesForMastra,
  submittedMessagesForMemory,
  toAgentMessageInput,
};

export const __chatRunRegistryTest = createAgentRunCoordinatorTestApi(new AgentRunCoordinator());
