import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { requestClientTool, resolveClientToolHostForTarget } from '../../../client-tools/registry';
import { formatToolModelOutput, getCodeToolModelOutputMaxChars } from './model-output';
import { getThreadBinding, offlineMessage } from './portal-tools';

type EditorContextOutput = {
  ok: boolean;
  error?: string;
  reason?: string;
  clientId?: string;
  context?: Record<string, unknown>;
};

const textPreview = (value: unknown, maxChars = 2_400) => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n... ${value.length - maxChars} chars omitted`;
};

const recordValue = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const summarizeTabs = (tabs: unknown) => Array.isArray(tabs)
  ? tabs.slice(0, 24).map(item => {
    const tab = recordValue(item);
    return [
      tab.active ? '*' : '-',
      typeof tab.path === 'string' ? tab.path : '(unknown)',
      tab.dirty ? 'dirty' : undefined,
      tab.loaded === false ? 'unloaded' : undefined,
      tab.preview ? 'preview' : undefined,
    ].filter(Boolean).join(' ');
  })
  : [];

const summarizeCoppermind = (coppermind: unknown) => {
  const context = recordValue(coppermind);
  const sections = Array.isArray(context.sections) ? context.sections : [];
  const rows = sections.slice(0, 40).map(item => {
    const section = recordValue(item);
    return [
      section.id === context.activeSectionId ? '*' : '-',
      typeof section.title === 'string' ? section.title : section.id,
      section.kind ? `kind=${section.kind}` : undefined,
      section.placement && typeof section.placement === 'object'
        ? `placement=${(section.placement as Record<string, unknown>).state ?? 'unknown'}`
        : undefined,
      section.preview ? `preview=${JSON.stringify(section.preview).slice(0, 180)}` : undefined,
    ].filter(Boolean).join(' ');
  });
  if (!rows.length) return undefined;
  return [
    `coppermind mode=${context.mode ?? 'unknown'} activeSection=${context.activeSectionId ?? 'none'} sections=${sections.length}`,
    ...rows,
    sections.length > rows.length ? `... ${sections.length - rows.length} sections omitted` : undefined,
  ].filter(Boolean).join('\n');
};

const editorContextModelOutput = (output: unknown, maxChars = getCodeToolModelOutputMaxChars()) => {
  const result = recordValue(output);
  const context = recordValue(result.context);
  const activeBuffer = recordValue(context.activeBuffer);
  const codeMirror = recordValue(activeBuffer.codeMirror);
  const selection = recordValue(codeMirror.selection);
  const visibleRange = recordValue(codeMirror.visibleRange);
  const body = [
    summarizeTabs(context.openTabs).length
      ? ['open tabs:', ...summarizeTabs(context.openTabs)].join('\n')
      : undefined,
    activeBuffer.path
      ? [
        `active buffer: ${activeBuffer.path}`,
        `kind=${activeBuffer.documentKind ?? 'unknown'} dirty=${activeBuffer.dirty === true}`,
        activeBuffer.contentHash ? `contentHash=${activeBuffer.contentHash}` : undefined,
      ].filter(Boolean).join('\n')
      : undefined,
    selection.text ? `selection:\n${textPreview(selection.text)}` : undefined,
    visibleRange.text ? `visible range:\n${textPreview(visibleRange.text)}` : undefined,
    summarizeCoppermind(activeBuffer.coppermind),
  ].filter(Boolean).join('\n\n');

  return formatToolModelOutput(
    'editor_context',
    [
      ['ok', result.ok],
      ['reason', result.reason],
      ['clientId', result.clientId],
      ['mode', context.mode],
      ['projectId', context.projectId],
      ['workspaceId', context.workspaceId],
      ['updatedAt', context.updatedAt],
      ['error', result.error],
    ],
    body,
    maxChars,
  );
};

const normalizeClientToolResult = (value: unknown, clientId: string): EditorContextOutput => {
  const result = recordValue(value);
  if (result.ok === false) {
    return {
      ok: false,
      clientId,
      error: typeof result.error === 'string' ? result.error : undefined,
      reason: typeof result.reason === 'string' ? result.reason : 'client_error',
    };
  }
  const context = recordValue(result.context);
  return {
    ok: true,
    clientId,
    context,
  };
};

export const editorContextTool = createTool({
  id: 'editor_context',
  description: 'Read the live editor context from the connected Weave client for this Workspace. Use when the user asks about open buffers, unsaved editor content, current selection, visible code/notes, or Coppermind cells/canvas state.',
  inputSchema: z.object({
    mode: z.enum(['code', 'notes']).optional().describe('Optional editor mode to prefer. Defaults to the current Workspace context.'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    error: z.string().optional(),
    reason: z.string().optional(),
    clientId: z.string().optional(),
    context: z.record(z.string(), z.unknown()).optional(),
  }),
  execute: async (input, context): Promise<EditorContextOutput> => {
    let binding: Awaited<ReturnType<typeof getThreadBinding>>;
    try {
      binding = await getThreadBinding(context);
    } catch (error) {
      return {
        ok: false,
        reason: 'not_bound',
        error: error instanceof Error ? error.message : offlineMessage,
      };
    }

    const client = resolveClientToolHostForTarget({
      userId: binding.resourceId,
      projectId: binding.projectId,
      workspaceId: binding.workspaceId,
      threadId: context.agent?.threadId,
      capability: 'editor.context',
    });

    if (!client) {
      return {
        ok: false,
        reason: 'no_client',
        error: 'No active Weave client is connected for this Workspace.',
      };
    }

    try {
      return normalizeClientToolResult(await requestClientTool({
        clientId: client.clientId,
        tool: 'editor.context',
        args: {
          projectId: binding.projectId,
          workspaceId: binding.workspaceId,
          mode: input.mode,
        },
        timeoutMs: 5_000,
      }), client.clientId);
    } catch (error) {
      return {
        ok: false,
        clientId: client.clientId,
        reason: 'request_failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
  toModelOutput: editorContextModelOutput,
});

export const __editorContextToolsTest = {
  editorContextModelOutput,
};
