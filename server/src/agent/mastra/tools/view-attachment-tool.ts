import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { attachmentModelUrl } from '../../../modules/attachments/storage';
import { resourceService } from '../../../services/resource-service';
import { callerForOwner } from '../../../services/types';
import { toolDescription, toolInputDescription } from './instructions';

export const viewAttachmentTool = createTool({
  id: 'view_attachment',
  description: toolDescription('view_attachment'),
  inputSchema: z.object({
    attachmentId: z.string().regex(/^[A-Za-z0-9_-]+$/).max(128).describe(
      toolInputDescription('view_attachment', 'attachmentId'),
    ),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    attachmentId: z.string(),
    imageUrl: z.string(),
    mimeType: z.string().optional(),
    originalName: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (input, context) => {
    const resourceId = typeof context.agent?.resourceId === 'string' ? context.agent.resourceId : undefined;
    const threadId = typeof context.agent?.threadId === 'string' ? context.agent.threadId : undefined;
    if (!resourceId || !threadId) {
      return { ok: false, attachmentId: input.attachmentId, imageUrl: '', error: 'Thread context is unavailable.' };
    }
    const attachment = await resourceService.getAttachment(
      callerForOwner(resourceId, 'agent', { threadId }),
      input.attachmentId,
    );
    if (!attachment || attachment.threadId !== threadId || !attachment.mimeType.startsWith('image/')) {
      return {
        ok: false,
        attachmentId: input.attachmentId,
        imageUrl: '',
        error: 'Image attachment was not found in this thread.',
      };
    }
    return {
      ok: true,
      attachmentId: input.attachmentId,
      imageUrl: attachmentModelUrl(input.attachmentId),
      mimeType: attachment.mimeType,
      originalName: attachment.originalName,
    };
  },
  toModelOutput: (output) =>
    output.ok
      ? {
        type: 'content',
        value: [
          { type: 'text', text: `Re-viewed image ${output.originalName ?? output.attachmentId}.` },
          { type: 'image-url', url: output.imageUrl },
        ],
      }
      : { type: 'text', value: output.error ?? 'Image attachment could not be viewed.' },
});
