import {
  type AttachmentPayload,
  type AttachmentReadResult,
  type AttachmentStorage,
  attachmentStorage,
  type StoredAttachment,
  type StoredAttachmentMetadata,
} from '../modules/attachments/storage';
import type { ServiceCaller } from './types';
import { optionalString, ServiceError } from './types';

export interface ResourceService {
  putAttachment(caller: ServiceCaller, input: AttachmentPayload): Promise<StoredAttachment>;
  getAttachment(caller: ServiceCaller, attachmentId: string): Promise<AttachmentReadResult | null>;
  findAttachmentsByThread(caller: ServiceCaller, threadId: string): Promise<StoredAttachmentMetadata[]>;
  findAttachmentsByOriginalName(
    caller: ServiceCaller,
    originalName: string,
    mimeType?: string,
  ): Promise<StoredAttachmentMetadata[]>;
  deleteAttachment(caller: ServiceCaller, attachmentId: string): Promise<void>;
}

export class DefaultResourceService implements ResourceService {
  constructor(private readonly attachments: AttachmentStorage = attachmentStorage) {}

  async putAttachment(caller: ServiceCaller, input: AttachmentPayload) {
    return this.attachments.put({
      ...input,
      ownerId: input.ownerId ?? caller.ownerId,
    });
  }

  async getAttachment(caller: ServiceCaller, attachmentId: string) {
    const id = optionalString(attachmentId);
    if (!id) throw new ServiceError('invalid_scope', 'attachmentId is required.', 400);
    return this.forCaller(caller, await this.attachments.get(id));
  }

  async findAttachmentsByThread(caller: ServiceCaller, threadId: string) {
    const id = optionalString(threadId);
    if (!id) throw new ServiceError('invalid_scope', 'threadId is required.', 400);
    return (await this.attachments.findByThread(id)).filter((attachment) => this.isVisibleToCaller(caller, attachment));
  }

  async findAttachmentsByOriginalName(caller: ServiceCaller, originalName: string, mimeType?: string) {
    const name = optionalString(originalName);
    if (!name) throw new ServiceError('invalid_scope', 'originalName is required.', 400);
    return (await this.attachments.findByOriginalName(name, mimeType)).filter((attachment) =>
      this.isVisibleToCaller(caller, attachment)
    );
  }

  async deleteAttachment(caller: ServiceCaller, attachmentId: string) {
    const id = optionalString(attachmentId);
    if (!id) return;
    const existing = await this.getAttachment(caller, id);
    if (!existing) return;
    await this.attachments.delete(id);
  }

  private forCaller<T extends { ownerId?: string } | null>(caller: ServiceCaller, attachment: T): T | null {
    if (!attachment) return null;
    return this.isVisibleToCaller(caller, attachment) ? attachment : null;
  }

  private isVisibleToCaller(caller: ServiceCaller, attachment: { ownerId?: string }) {
    return caller.kind === 'system' || !attachment.ownerId || attachment.ownerId === caller.ownerId;
  }
}

export const resourceService = new DefaultResourceService();
