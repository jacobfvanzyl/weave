import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { toolDescription, toolInputDescription } from './instructions';
import { routePortalTool } from './portal-tools';
import { formatToolModelOutput, getCodeToolModelOutputMaxChars } from './model-output';

const positionSchema = (toolId: string) => ({
  line: z.number().int().min(0).optional().describe(toolInputDescription(toolId, 'line')),
  character: z.number().int().min(0).optional().describe(toolInputDescription(toolId, 'character')),
});

const rangeSchema = z.object({
  start: z.object({
    line: z.number().int().min(0),
    character: z.number().int().min(0),
  }).strict(),
  end: z.object({
    line: z.number().int().min(0),
    character: z.number().int().min(0),
  }).strict(),
}).strict();

const baseInputSchema = (toolId: string) => z.object({
  path: z.string().describe(toolInputDescription(toolId, 'path')),
  languageId: z.string().optional().describe(toolInputDescription(toolId, 'languageId')),
  serverId: z.string().optional().describe(toolInputDescription(toolId, 'serverId')),
});

const positionInputSchema = (toolId: string) => baseInputSchema(toolId).extend(positionSchema(toolId));

const queryOutputSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
}).passthrough();

const cleanPortalResult = (result: unknown, path?: string) => {
  const record = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  const ok = typeof record.ok === 'boolean' ? record.ok : record.error === undefined;
  const error = typeof record.error === 'string' ? record.error : ok ? undefined : 'Portal returned an invalid LSP result.';
  const { id: _id, type: _type, ...body } = record;
  return {
    ok,
    ...(path ? { path } : {}),
    ...body,
    ...(error ? { error } : {}),
  };
};

const runLspQuery = async (feature: string, input: Record<string, unknown>, context: any) =>
  cleanPortalResult(
    await routePortalTool('portal.lsp.query', { feature, ...input }, context, 20_000),
    typeof input.path === 'string' ? input.path : undefined,
  );

const lspModelOutput = (name: string, output: unknown) => {
  const result = output && typeof output === 'object' ? output as Record<string, unknown> : {};
  return formatToolModelOutput(name, [
    ['ok', result.ok],
    ['path', result.path],
    ['serverId', result.serverId],
    ['languageId', result.languageId],
    ['status', result.status],
    ['previewOnly', result.previewOnly],
    ['error', result.error],
  ], result, getCodeToolModelOutputMaxChars());
};

export const codeIntelCapabilitiesTool = createTool({
  id: 'code_intel_capabilities',
  description: toolDescription('code_intel_capabilities'),
  inputSchema: baseInputSchema('code_intel_capabilities'),
  outputSchema: queryOutputSchema,
  execute: async (input, context) => await runLspQuery('capabilities', input, context),
  toModelOutput: output => lspModelOutput('code_intel_capabilities', output),
});

export const codeDiagnosticsTool = createTool({
  id: 'code_diagnostics',
  description: toolDescription('code_diagnostics'),
  inputSchema: baseInputSchema('code_diagnostics'),
  outputSchema: queryOutputSchema,
  execute: async (input, context) => await runLspQuery('diagnostics', input, context),
  toModelOutput: output => lspModelOutput('code_diagnostics', output),
});

export const codeHoverTool = createTool({
  id: 'code_hover',
  description: toolDescription('code_hover'),
  inputSchema: positionInputSchema('code_hover'),
  outputSchema: queryOutputSchema,
  execute: async (input, context) => await runLspQuery('hover', input, context),
  toModelOutput: output => lspModelOutput('code_hover', output),
});

export const codeDefinitionTool = createTool({
  id: 'code_definition',
  description: toolDescription('code_definition'),
  inputSchema: positionInputSchema('code_definition'),
  outputSchema: queryOutputSchema,
  execute: async (input, context) => await runLspQuery('definition', input, context),
  toModelOutput: output => lspModelOutput('code_definition', output),
});

export const codeReferencesTool = createTool({
  id: 'code_references',
  description: toolDescription('code_references'),
  inputSchema: positionInputSchema('code_references'),
  outputSchema: queryOutputSchema,
  execute: async (input, context) => await runLspQuery('references', input, context),
  toModelOutput: output => lspModelOutput('code_references', output),
});

export const codeSymbolsTool = createTool({
  id: 'code_symbols',
  description: toolDescription('code_symbols'),
  inputSchema: baseInputSchema('code_symbols'),
  outputSchema: queryOutputSchema,
  execute: async (input, context) => await runLspQuery('symbols', input, context),
  toModelOutput: output => lspModelOutput('code_symbols', output),
});

export const workspaceSymbolsTool = createTool({
  id: 'workspace_symbols',
  description: toolDescription('workspace_symbols'),
  inputSchema: baseInputSchema('workspace_symbols').extend({
    query: z.string().optional().describe(toolInputDescription('workspace_symbols', 'query')),
  }),
  outputSchema: queryOutputSchema,
  execute: async (input, context) => await runLspQuery('workspaceSymbols', input, context),
  toModelOutput: output => lspModelOutput('workspace_symbols', output),
});

export const codeActionsTool = createTool({
  id: 'code_actions',
  description: toolDescription('code_actions'),
  inputSchema: positionInputSchema('code_actions').extend({
    range: rangeSchema.optional(),
  }),
  outputSchema: queryOutputSchema,
  execute: async (input, context) => await runLspQuery('codeActions', input, context),
  toModelOutput: output => lspModelOutput('code_actions', output),
});

export const codeActionPreviewTool = createTool({
  id: 'code_action_preview',
  description: toolDescription('code_action_preview'),
  inputSchema: positionInputSchema('code_action_preview').extend({
    range: rangeSchema.optional(),
    action: z.unknown().optional().describe(toolInputDescription('code_action_preview', 'action')),
    actionIndex: z.number().int().min(0).optional().describe(
      toolInputDescription('code_action_preview', 'actionIndex'),
    ),
  }),
  outputSchema: queryOutputSchema,
  execute: async (input, context) => await runLspQuery('codeActionPreview', input, context),
  toModelOutput: output => lspModelOutput('code_action_preview', output),
});

export const renamePreviewTool = createTool({
  id: 'rename_preview',
  description: toolDescription('rename_preview'),
  inputSchema: positionInputSchema('rename_preview').extend({
    newName: z.string().describe(toolInputDescription('rename_preview', 'newName')),
  }),
  outputSchema: queryOutputSchema,
  execute: async (input, context) => await runLspQuery('renamePreview', input, context),
  toModelOutput: output => lspModelOutput('rename_preview', output),
});

export const formatPreviewTool = createTool({
  id: 'format_preview',
  description: toolDescription('format_preview'),
  inputSchema: baseInputSchema('format_preview'),
  outputSchema: queryOutputSchema,
  execute: async (input, context) => await runLspQuery('formatPreview', input, context),
  toModelOutput: output => lspModelOutput('format_preview', output),
});
