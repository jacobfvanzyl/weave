import { defineRoute } from '../../../server/routes';
import type { ResourceService } from '../../../services/resource-service';
import { callerForOwner } from '../../../services/types';
import { attachmentStorage } from '../storage';

export const createAttachmentRoutes = (resources?: ResourceService) => [
  defineRoute('/attachments/:attachmentId', {
    method: 'GET',
    handler: async (c) => {
      const owner = c.get('owner');
      if (!owner) return c.text('Unauthorized', 401);

      const attachmentId = c.req.param('attachmentId');
      const attachment = resources
        ? await resources.getAttachment(callerForOwner(owner.id, 'ui'), attachmentId)
        : await attachmentStorage.get(attachmentId);

      if (!attachment) return c.text('Not Found', 404);

      const body = attachment.bytes.buffer.slice(
        attachment.bytes.byteOffset,
        attachment.bytes.byteOffset + attachment.bytes.byteLength,
      ) as ArrayBuffer;

      return new Response(body, {
        headers: {
          'content-type': attachment.mimeType,
          'content-length': String(attachment.sizeBytes),
          'content-disposition': `inline; filename="${attachment.originalName.replace(/["\r\n]/g, '')}"`,
          'cache-control': 'private, max-age=31536000, immutable',
        },
      });
    },
  }),
];

export const attachmentRoutes = createAttachmentRoutes();
