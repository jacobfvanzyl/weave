import { createTool } from '@mastra/core/tools';
import Exa from 'exa-js';
import { z } from 'zod';
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
  description:
    'Search the web with Exa for current or external information. Returns relevant results with URLs, snippets, optional summaries, and optional full text.',
  inputSchema: z.object({
    query: z.string().min(1).describe('Search query'),
    maxResults: z.number().min(1).max(10).optional().describe('Maximum results to return'),
    includeText: z.boolean().optional().describe('Include cleaned page text in each result'),
    includeSummary: z.boolean().optional().describe('Include Exa-generated summaries in each result'),
    includeHighlights: z.boolean().optional().describe('Include relevant highlights in each result'),
    includeDomains: z.array(z.string()).optional().describe('Restrict search to these domains'),
    excludeDomains: z.array(z.string()).optional().describe('Exclude these domains'),
    timeRange: z.enum(['day', 'week', 'month', 'year']).optional().describe('Filter by recency'),
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
  description: 'Extract readable content from one or more URLs with Exa. Use after webSearch when full source content is needed.',
  inputSchema: z.object({
    urls: z.array(z.string()).min(1).max(10).describe('URLs to extract content from'),
    includeSummary: z.boolean().optional().describe('Include Exa-generated summaries'),
    includeHighlights: z.boolean().optional().describe('Include relevant highlights'),
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
