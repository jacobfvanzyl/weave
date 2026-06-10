import { describe, expect, it } from 'vitest';
import { __chatgptCodexLanguageModelTest } from '../../server/src/mastra/providers/chatgpt-codex-language-model';

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

    expect(parts.map(part => {
      if (part.type === 'text-start' || part.type === 'text-end') return `${part.type}:${part.id}`;
      if (part.type === 'text-delta') return `${part.type}:${part.id}:${part.delta}`;
      if (part.type === 'tool-input-start') return `${part.type}:${part.id}:${part.toolName}`;
      if (part.type === 'tool-input-delta') return `${part.type}:${part.id}:${part.delta}`;
      if (part.type === 'tool-input-end') return `${part.type}:${part.id}`;
      if (part.type === 'tool-call') return `${part.type}:${part.toolCallId}:${part.toolName}:${part.input}`;
      if (part.type === 'finish') return `${part.type}:${part.finishReason}:${part.usage.totalTokens}`;
      return part.type;
    })).toEqual([
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
});
