import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { routePortalTool } from './portal-tools';
import { formatToolModelOutput, getCodeToolModelOutputMaxChars } from './model-output';

const positionSchema = {
  line: z.number().int().min(0).optional().describe('Zero-based line number'),
  character: z.number().int().min(0).optional().describe('Zero-based UTF-16 character offset'),
};

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

const baseInputSchema = z.object({
  path: z.string().describe('File path relative to the current Workspace root'),
  languageId: z.string().optional().describe('Optional LSP language id override'),
  serverId: z.string().optional().describe('Optional language-server adapter id override'),
});

const positionInputSchema = baseInputSchema.extend(positionSchema);

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
  description: 'Inspect configured language-server metadata and runtime capabilities for a file in the current Code workspace.',
  inputSchema: baseInputSchema,
  outputSchema: queryOutputSchema,
  execute: async (input, context) => await runLspQuery('capabilities', input, context),
  toModelOutput: output => lspModelOutput('code_intel_capabilities', output),
});

export const codeDiagnosticsTool = createTool({
  id: 'code_diagnostics',
  description: 'Read LSP diagnostics for a file. Diagnostics preserve server source, severity, range, code, and message where provided.',
  inputSchema: baseInputSchema,
  outputSchema: queryOutputSchema,
  execute: async (input, context) => await runLspQuery('diagnostics', input, context),
  toModelOutput: output => lspModelOutput('code_diagnostics', output),
});

export const codeHoverTool = createTool({
  id: 'code_hover',
  description: 'Read LSP hover information for a zero-based file position.',
  inputSchema: positionInputSchema,
  outputSchema: queryOutputSchema,
  execute: async (input, context) => await runLspQuery('hover', input, context),
  toModelOutput: output => lspModelOutput('code_hover', output),
});

export const codeDefinitionTool = createTool({
  id: 'code_definition',
  description: 'Find LSP definitions for a zero-based file position.',
  inputSchema: positionInputSchema,
  outputSchema: queryOutputSchema,
  execute: async (input, context) => await runLspQuery('definition', input, context),
  toModelOutput: output => lspModelOutput('code_definition', output),
});

export const codeReferencesTool = createTool({
  id: 'code_references',
  description: 'Find LSP references for a zero-based file position.',
  inputSchema: positionInputSchema,
  outputSchema: queryOutputSchema,
  execute: async (input, context) => await runLspQuery('references', input, context),
  toModelOutput: output => lspModelOutput('code_references', output),
});

export const codeSymbolsTool = createTool({
  id: 'code_symbols',
  description: 'List LSP document symbols for a file.',
  inputSchema: baseInputSchema,
  outputSchema: queryOutputSchema,
  execute: async (input, context) => await runLspQuery('symbols', input, context),
  toModelOutput: output => lspModelOutput('code_symbols', output),
});

export const workspaceSymbolsTool = createTool({
  id: 'workspace_symbols',
  description: 'Search LSP workspace symbols. Provide any file path in the target workspace so Weave can select the server/root.',
  inputSchema: baseInputSchema.extend({
    query: z.string().optional().describe('Workspace symbol query'),
  }),
  outputSchema: queryOutputSchema,
  execute: async (input, context) => await runLspQuery('workspaceSymbols', input, context),
  toModelOutput: output => lspModelOutput('workspace_symbols', output),
});

export const codeActionsTool = createTool({
  id: 'code_actions',
  description: 'List LSP code actions for a file range without applying them.',
  inputSchema: positionInputSchema.extend({
    range: rangeSchema.optional(),
  }),
  outputSchema: queryOutputSchema,
  execute: async (input, context) => await runLspQuery('codeActions', input, context),
  toModelOutput: output => lspModelOutput('code_actions', output),
});

export const codeActionPreviewTool = createTool({
  id: 'code_action_preview',
  description: 'Preview the WorkspaceEdit for an LSP code action. This never applies edits.',
  inputSchema: positionInputSchema.extend({
    range: rangeSchema.optional(),
    action: z.unknown().optional().describe('A CodeAction object returned by code_actions'),
    actionIndex: z.number().int().min(0).optional().describe('Index from code_actions to preview when action is omitted'),
  }),
  outputSchema: queryOutputSchema,
  execute: async (input, context) => await runLspQuery('codeActionPreview', input, context),
  toModelOutput: output => lspModelOutput('code_action_preview', output),
});

export const renamePreviewTool = createTool({
  id: 'rename_preview',
  description: 'Preview an LSP rename WorkspaceEdit. This never applies edits.',
  inputSchema: positionInputSchema.extend({
    newName: z.string().describe('Replacement symbol name'),
  }),
  outputSchema: queryOutputSchema,
  execute: async (input, context) => await runLspQuery('renamePreview', input, context),
  toModelOutput: output => lspModelOutput('rename_preview', output),
});

export const formatPreviewTool = createTool({
  id: 'format_preview',
  description: 'Preview LSP document formatting edits. This never applies edits.',
  inputSchema: baseInputSchema,
  outputSchema: queryOutputSchema,
  execute: async (input, context) => await runLspQuery('formatPreview', input, context),
  toModelOutput: output => lspModelOutput('format_preview', output),
});
