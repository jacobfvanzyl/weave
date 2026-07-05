import {
  type AttachmentPayload,
  type AttachmentReadResult,
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
  deleteAttachment(caller: ServiceCaller, attachmentId: string): Promise<void>;
}

export class DefaultResourceService implements ResourceService {
  async putAttachment(_caller: ServiceCaller, input: AttachmentPayload) {
    return attachmentStorage.put(input);
  }

  async getAttachment(_caller: ServiceCaller, attachmentId: string) {
    const id = optionalString(attachmentId);
    if (!id) throw new ServiceError('invalid_scope', 'attachmentId is required.', 400);
    return attachmentStorage.get(id);
  }

  async findAttachmentsByThread(_caller: ServiceCaller, threadId: string) {
    const id = optionalString(threadId);
    if (!id) throw new ServiceError('invalid_scope', 'threadId is required.', 400);
    return attachmentStorage.findByThread(id);
  }

  async deleteAttachment(_caller: ServiceCaller, attachmentId: string) {
    const id = optionalString(attachmentId);
    if (!id) return;
    await attachmentStorage.delete(id);
  }
}
