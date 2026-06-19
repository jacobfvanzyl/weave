import { describe, expect, it } from 'vitest';
import { __chatgptCodexLanguageModelTest } from '../../server/src/mastra/providers/chatgpt-codex-language-model';

const describeStreamPart = (part: Awaited<ReturnType<typeof __chatgptCodexLanguageModelTest.collectCodexResponseStreamParts>>[number]) => {
  if (part.type === 'text-start' || part.type === 'text-end') return `${part.type}:${part.id}`;
  if (part.type === 'text-delta') return `${part.type}:${part.id}:${part.delta}`;
  if (part.type === 'reasoning-start' || part.type === 'reasoning-end') return `${part.type}:${part.id}`;
  if (part.type === 'reasoning-delta') return `${part.type}:${part.id}:${part.delta}`;
  if (part.type === 'tool-input-start') return `${part.type}:${part.id}:${part.toolName}`;
  if (part.type === 'tool-input-delta') return `${part.type}:${part.id}:${part.delta}`;
  if (part.type === 'tool-input-end') return `${part.type}:${part.id}`;
  if (part.type === 'tool-call') return `${part.type}:${part.toolCallId}:${part.toolName}:${part.input}`;
  if (part.type === 'finish') return `${part.type}:${part.finishReason}:${part.usage.totalTokens}`;
  if (part.type === 'error') return `${part.type}:${part.error instanceof Error ? part.error.message : String(part.error)}`;
  return part.type;
};

describe('ChatGPT Codex stream mapping', () => {
  it('keeps text/tool/text response items as separate ordered stream parts', async () => {
    const parts = await __chatgptCodexLanguageModelTest.collectCodexResponseStreamParts([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'msg_1', type: 'message' },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: 'Before the command.',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'msg_1', type: 'message' },
      },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'bash' },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        delta: '{"command":"pwd"}',
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'bash', arguments: '{"command":"pwd"}' },
      },
      {
        type: 'response.output_item.added',
        output_index: 2,
        item: { id: 'msg_2', type: 'message' },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_2',
        output_index: 2,
        content_index: 0,
        delta: 'After the command.',
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          status: 'completed',
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        },
      },
    ]);

    expect(parts.map(describeStreamPart)).toEqual([
      'stream-start',
      'text-start:text-msg_1-0',
      'text-delta:text-msg_1-0:Before the command.',
      'text-end:text-msg_1-0',
      'tool-input-start:call_1:bash',
      'tool-input-delta:call_1:{"command":"pwd"}',
      'tool-input-end:call_1',
      'tool-call:call_1:bash:{"command":"pwd"}',
      'text-start:text-msg_2-0',
      'text-delta:text-msg_2-0:After the command.',
      'text-end:text-msg_2-0',
      'finish:stop:3',
    ]);
  });

  it('maps reasoning summary events around tool calls without exposing raw reasoning text', async () => {
    const parts = await __chatgptCodexLanguageModelTest.collectCodexResponseStreamParts([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'rs_1', type: 'reasoning' },
      },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        delta: 'I need to inspect the workspace.',
      },
      {
        type: 'response.reasoning_summary_part.done',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        part: { type: 'summary_text', text: 'I need to inspect the workspace.' },
      },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        delta: 'I need to inspect the workspace.',
      },
      {
        type: 'response.reasoning_summary_text.done',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        text: 'I need to inspect the workspace.',
      },
      {
        type: 'response.reasoning_text.delta',
        item_id: 'rs_1',
        output_index: 0,
        content_index: 0,
        delta: 'hidden raw chain of thought',
      },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'bash' },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        delta: '{"command":"rg reasoning"}',
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'bash', arguments: '{"command":"rg reasoning"}' },
      },
      {
        type: 'response.output_item.added',
        output_index: 2,
        item: { id: 'rs_2', type: 'reasoning' },
      },
      {
        type: 'response.reasoning_summary_text.done',
        item_id: 'rs_2',
        output_index: 2,
        summary_index: 0,
        text: 'The search found the missing adapter branch.',
      },
      {
        type: 'response.output_item.added',
        output_index: 3,
        item: { id: 'msg_1', type: 'message' },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 3,
        content_index: 0,
        delta: 'Here is the fix.',
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          status: 'completed',
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        },
      },
    ]);

    expect(parts.map(describeStreamPart)).toEqual([
      'stream-start',
      'reasoning-start:reasoning-summary-rs_1-0',
      'reasoning-delta:reasoning-summary-rs_1-0:I need to inspect the workspace.',
      'reasoning-end:reasoning-summary-rs_1-0',
      'tool-input-start:call_1:bash',
      'tool-input-delta:call_1:{"command":"rg reasoning"}',
      'tool-input-end:call_1',
      'tool-call:call_1:bash:{"command":"rg reasoning"}',
      'reasoning-start:reasoning-summary-rs_2-0',
      'reasoning-delta:reasoning-summary-rs_2-0:The search found the missing adapter branch.',
      'reasoning-end:reasoning-summary-rs_2-0',
      'text-start:text-msg_1-0',
      'text-delta:text-msg_1-0:Here is the fix.',
      'text-end:text-msg_1-0',
      'finish:stop:3',
    ]);
  });

  it('emits an error instead of an unknown finish when the upstream stream ends without a terminal event', async () => {
    const parts = await __chatgptCodexLanguageModelTest.collectCodexResponseStreamParts([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'msg_1', type: 'message' },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: 'Partial response',
      },
    ]);

    expect(parts.map(describeStreamPart)).toEqual([
      'stream-start',
      'text-start:text-msg_1-0',
      'text-delta:text-msg_1-0:Partial response',
      'text-end:text-msg_1-0',
      'error:ChatGPT Codex response stream ended before a terminal response event.',
    ]);
  });
});
