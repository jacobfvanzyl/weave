import { createTool } from '@mastra/core/tools';
import { Exa } from 'exa-js';
import { z } from 'zod';
import { toolDescription, toolInputDescription } from './instructions';
import { formatToolModelOutput } from './model-output';

const getExaClient = () => {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) throw new Error('EXA_API_KEY is required for web search tools');
  return new Exa(apiKey);
};

let client: Exa | null = null;

const getClient = () => {
  client ??= getExaClient();
  return client;
};

const dateFromRange = (range: 'day' | 'week' | 'month' | 'year') => {
  const date = new Date();
  const days = range === 'day' ? 1 : range === 'week' ? 7 : range === 'month' ? 30 : 365;
  date.setDate(date.getDate() - days);
  return date.toISOString();
};

const webResultsModelOutput = (heading: string, output: unknown) => {
  const result = output && typeof output === 'object' ? output as Record<string, unknown> : {};
  const results = Array.isArray(result.results) ? result.results as Array<Record<string, unknown>> : [];
  const body = results.map((item, index) => [
    `${index + 1}. ${typeof item.title === 'string' ? item.title : 'Untitled'}`,
    typeof item.url === 'string' ? item.url : undefined,
    typeof item.publishedDate === 'string' ? `published: ${item.publishedDate}` : undefined,
    typeof item.content === 'string' ? item.content : undefined,
  ].filter(Boolean).join('\n')).join('\n\n');

  return formatToolModelOutput(
    heading,
    [
      ['query', result.query],
      ['results', results.length],
    ],
    body,
    2_000,
  );
};

export const webSearchTool = createTool({
  id: 'webSearch',
  description: toolDescription('webSearch'),
  inputSchema: z.object({
    query: z.string().min(1).describe(toolInputDescription('webSearch', 'query')),
    maxResults: z.number().min(1).max(10).optional().describe(toolInputDescription('webSearch', 'maxResults')),
    includeText: z.boolean().optional().describe(toolInputDescription('webSearch', 'includeText')),
    includeSummary: z.boolean().optional().describe(toolInputDescription('webSearch', 'includeSummary')),
    includeHighlights: z.boolean().optional().describe(toolInputDescription('webSearch', 'includeHighlights')),
    includeDomains: z.array(z.string()).optional().describe(toolInputDescription('webSearch', 'includeDomains')),
    excludeDomains: z.array(z.string()).optional().describe(toolInputDescription('webSearch', 'excludeDomains')),
    timeRange: z.enum(['day', 'week', 'month', 'year']).optional().describe(
      toolInputDescription('webSearch', 'timeRange'),
    ),
  }),
  outputSchema: z.object({
    query: z.string(),
    results: z.array(
      z.object({
        title: z.string().nullable(),
        url: z.string(),
        content: z.string(),
        publishedDate: z.string().optional(),
        author: z.string().optional(),
        score: z.number().optional(),
      }),
    ),
  }),
  execute: async input => {
    const response = await getClient().searchAndContents(input.query, {
      type: 'auto',
      numResults: input.maxResults ?? 5,
      includeDomains: input.includeDomains,
      excludeDomains: input.excludeDomains,
      startPublishedDate: input.timeRange ? dateFromRange(input.timeRange) : undefined,
      contents: {
        text: input.includeText ? true : undefined,
        summary: input.includeSummary ? true : undefined,
        highlights: input.includeHighlights === false ? undefined : true,
      },
    });

    return {
      query: input.query,
      results: response.results.map(result => {
        const resultContent = result as typeof result & { highlights?: string[]; summary?: string; text?: string };
        const highlights = Array.isArray(resultContent.highlights) ? resultContent.highlights.join('\n') : '';
        const summary = typeof resultContent.summary === 'string' ? resultContent.summary : '';
        const text = typeof resultContent.text === 'string' ? resultContent.text : '';
        const content = summary || highlights || text;

        return {
          title: result.title ?? null,
          url: result.url,
          content: content.slice(0, input.includeText ? 4000 : 1000),
          publishedDate: result.publishedDate,
          author: result.author,
          score: result.score,
        };
      }),
    };
  },
  toModelOutput: output => webResultsModelOutput('webSearch', output),
});

export const webExtractTool = createTool({
  id: 'webExtract',
  description: toolDescription('webExtract'),
  inputSchema: z.object({
    urls: z.array(z.string()).min(1).max(10).describe(toolInputDescription('webExtract', 'urls')),
    includeSummary: z.boolean().optional().describe(toolInputDescription('webExtract', 'includeSummary')),
    includeHighlights: z.boolean().optional().describe(toolInputDescription('webExtract', 'includeHighlights')),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        title: z.string().nullable(),
        url: z.string(),
        content: z.string(),
        publishedDate: z.string().optional(),
        author: z.string().optional(),
      }),
    ),
  }),
  execute: async input => {
    const response = await getClient().getContents(input.urls, {
      text: true,
      summary: input.includeSummary ? true : undefined,
      highlights: input.includeHighlights ? true : undefined,
    });

    return {
      results: response.results.map(result => {
        const resultContent = result as typeof result & { highlights?: string[]; summary?: string; text?: string };
        const highlights = Array.isArray(resultContent.highlights) ? resultContent.highlights.join('\n') : '';
        const summary = typeof resultContent.summary === 'string' ? resultContent.summary : '';
        const text = typeof resultContent.text === 'string' ? resultContent.text : '';
        const content = text || summary || highlights;

        return {
          title: result.title ?? null,
          url: result.url,
          content: content.slice(0, 8000),
          publishedDate: result.publishedDate,
          author: result.author,
        };
      }),
    };
  },
  toModelOutput: output => webResultsModelOutput('webExtract', output),
});
