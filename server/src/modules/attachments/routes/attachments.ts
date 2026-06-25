import { defineRoute } from '../../../server/routes';
import { attachmentStorage } from '../storage';

export const attachmentRoutes = [
  defineRoute('/attachments/:attachmentId', {
    method: 'GET',
    handler: async c => {
      if (!c.get('owner')) return c.text('Unauthorized', 401);

      const attachmentId = c.req.param('attachmentId');
      const attachment = await attachmentStorage.get(attachmentId);

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
