import type { Attachment, AttachmentAdapter, CompleteAttachment, PendingAttachment } from '@assistant-ui/core';

const imageMimeTypesByExtension: Record<string, string> = {
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

const fileExtension = (name: string) => {
  const index = name.lastIndexOf('.');
  return index === -1 ? '' : name.slice(index).toLowerCase();
};

const inferImageMimeTypeFromBytes = (bytes: Uint8Array) => {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && String.fromCharCode(...bytes.subarray(0, 6)).startsWith('GIF')) return 'image/gif';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';

  return undefined;
};

export const inferImageMimeType = async (file: File) => {
  const declaredType = file.type.toLowerCase();
  if (declaredType.startsWith('image/')) return declaredType;

  const extensionType = imageMimeTypesByExtension[fileExtension(file.name)];
  if (extensionType) return extensionType;

  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  return inferImageMimeTypeFromBytes(header);
};

export const readImageFileAsDataUrl = async (file: File, mimeType: string) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
};

const isCompleteAttachment = (attachment: Attachment): attachment is CompleteAttachment =>
  attachment.status.type === 'complete';

export const imageAttachmentAdapter: AttachmentAdapter = {
  accept: '*',
  async add({ file }) {
    const mimeType = await inferImageMimeType(file);
    if (!mimeType) throw new Error('Only image attachments are supported');
    return {
      id: crypto.randomUUID(),
      type: 'image',
      name: file.name || 'image',
      file,
      contentType: mimeType,
      content: [],
      status: { type: 'requires-action', reason: 'composer-send' },
    };
  },
  async send(attachment) {
    const mimeType = attachment.contentType ?? await inferImageMimeType(attachment.file) ?? 'image/png';
    return {
      ...attachment,
      contentType: mimeType,
      status: { type: 'complete' },
      content: [
        {
          type: 'file',
          mimeType,
          filename: attachment.name,
          data: await readImageFileAsDataUrl(attachment.file, mimeType),
        },
      ],
    };
  },
  async remove() {},
};

export const completeImageAttachment = async (attachment: Attachment) => {
  if (isCompleteAttachment(attachment)) return attachment;
  if (attachment.status.type === 'incomplete') throw new Error('Attachment upload did not complete');
  return imageAttachmentAdapter.send(attachment as PendingAttachment);
};
