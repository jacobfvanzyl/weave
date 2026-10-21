import { describe, expect, it } from 'vitest';
import type { ContentBlock, SessionUpdate, ToolKind } from '@/host/protocol';
import {
  ACP_CONTENT_BLOCK_KINDS,
  ACP_SESSION_UPDATE_KINDS,
  ACP_TOOL_KINDS,
  createAcpShowcaseTranscript,
} from './acp-showcase';

describe('ACP renderer coverage catalog', () => {
  it('enumerates every current session update, content block, and tool kind', () => {
    const updateKinds: SessionUpdate['sessionUpdate'][] = [
      'user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk',
      'tool_call', 'tool_call_update', 'plan',
      'available_commands_update', 'current_mode_update', 'config_option_update',
      'session_info_update', 'usage_update', 'compaction_update',
      'compaction_summary_chunk', 'subagent_update', 'session_message', 'session_message_chunk',
    ];
    const contentKinds: ContentBlock['type'][] = [
      'text', 'image', 'audio', 'resource_link', 'resource',
    ];
    const toolKinds: ToolKind[] = [
      'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch',
      'switch_mode', 'other',
    ];

    expect(ACP_SESSION_UPDATE_KINDS).toEqual(updateKinds);
    expect(ACP_CONTENT_BLOCK_KINDS).toEqual(contentKinds);
    expect(ACP_TOOL_KINDS).toEqual(toolKinds);
  });

  it('builds a transcript containing every renderer family', () => {
    const model = createAcpShowcaseTranscript();
    expect(new Set(model.entries.map((entry) => entry.kind))).toEqual(new Set([
      'message', 'tool', 'plan', 'compaction', 'elicitation', 'diagnostic', 'subagent', 'session-message',
    ]));
    expect(model.subagents.map(({ title, transcript }) => [title, transcript.entries.map(({ kind }) => kind)])).toEqual([
      ['Robie', ['tool', 'message']],
    ]);
    expect(model.configOptions.map((option) => option.type)).toEqual([
      'select', 'boolean',
    ]);
  });
});
