import { registerApiRoute } from '@mastra/core/server';
import { expandPromptTemplate, listPromptSummaries } from '../prompt-templates/registry';

const maxArgumentsLength = 20_000;

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const promptRoutes = [
  registerApiRoute('/prompts', {
    method: 'GET',
    handler: async () => jsonResponse({ prompts: await listPromptSummaries() }),
  }),
  registerApiRoute('/prompts/:name/expand', {
    method: 'POST',
    handler: async c => {
      const name = c.req.param('name');
      const body = await c.req.json().catch(() => ({}));
      const args = typeof body.arguments === 'string' ? body.arguments : '';

      if (args.length > maxArgumentsLength) {
        return jsonResponse({ error: 'Prompt arguments too long' }, 413);
      }

      const text = await expandPromptTemplate(name, args);
      if (text === undefined) return jsonResponse({ error: 'Prompt not found' }, 404);

      return jsonResponse({ name, text });
    },
  }),
];
