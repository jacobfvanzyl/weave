import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { defineRoute } from '../../server/routes';
import { agentService } from '../service';

const maxArgumentsLength = 20_000;

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const optionalQueryString = (c: any, name: string) => {
  const value = c.req.query(name);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const optionalBodyString = (body: any, name: string) => {
  const value = body?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const promptContext = (c: any, values: Record<string, unknown> = {}) => {
  const resourceId = c.get('requestContext')?.get(MASTRA_RESOURCE_ID_KEY);
  return {
    resourceId: typeof resourceId === 'string' ? resourceId : undefined,
    threadId: values.threadId ?? optionalQueryString(c, 'threadId'),
    projectId: values.projectId ?? optionalQueryString(c, 'projectId'),
    workspaceId: values.workspaceId ?? optionalQueryString(c, 'workspaceId'),
  };
};

export const promptRoutes = [
  defineRoute('/agent/prompts', {
    method: 'GET',
    handler: async (c) => jsonResponse({ prompts: await agentService.listPromptTemplates(promptContext(c)) }),
  }),
  defineRoute('/agent/prompts/:name/expand', {
    method: 'POST',
    handler: async (c) => {
      const name = c.req.param('name');
      const body = await c.req.json().catch(() => ({}));
      const args = typeof body.arguments === 'string' ? body.arguments : '';
      const context = promptContext(c, {
        threadId: optionalBodyString(body, 'threadId'),
        projectId: optionalBodyString(body, 'projectId'),
        workspaceId: optionalBodyString(body, 'workspaceId'),
      });

      if (args.length > maxArgumentsLength) {
        return jsonResponse({ error: 'Prompt arguments too long' }, 413);
      }

      const text = await agentService.expandPrompt(name, args, context);
      if (text === undefined) return jsonResponse({ error: 'Prompt not found' }, 404);

      return jsonResponse({ name, text });
    },
  }),
];
