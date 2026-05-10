import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const maxTitleLength = 64;

const cleanTitle = (title: string) =>
  title
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxTitleLength);

export const renameThreadTool = createTool({
  id: 'rename-thread',
  description: 'Rename the current chat thread with a concise descriptive title. Use once early when the topic is clear.',
  inputSchema: z.object({
    title: z.string().min(1).max(maxTitleLength).describe('Concise title for the current thread'),
  }),
  outputSchema: z.object({
    title: z.string(),
    renamed: z.boolean(),
  }),
  execute: async ({ title }, context) => {
    const threadId = context.agent?.threadId;
    const resourceId = context.agent?.resourceId;
    const nextTitle = cleanTitle(title);

    if (!threadId || !resourceId) {
      return { title: nextTitle, renamed: false };
    }

    const agent = await context.mastra?.getAgent('mageHandAgent');
    const memory = await agent?.getMemory();
    if (!memory) {
      return { title: nextTitle, renamed: false };
    }

    const thread = await memory.getThreadById({ threadId });
    if (!thread || thread.resourceId !== resourceId) {
      return { title: nextTitle, renamed: false };
    }

    await memory.updateThread({
      id: threadId,
      title: nextTitle,
      metadata: thread.metadata,
    });

    return { title: nextTitle, renamed: true };
  },
});
