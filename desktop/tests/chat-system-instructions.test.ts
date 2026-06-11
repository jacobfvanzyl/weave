import { describe, expect, it } from 'vitest';
import {
  buildChatSystemMessages,
  formatRuntimeContext,
} from '../../server/src/mastra/agents/instructions';
import { RuntimeContextProcessor } from '../../server/src/mastra/runtime-context-processor';

describe('chat system instructions', () => {
  const now = new Date('2026-06-11T13:42:31.000Z');

  it('formats request-time context without second-level churn', () => {
    expect(formatRuntimeContext({ now, timeZone: 'Africa/Johannesburg' })).toBe([
      '# Runtime Context',
      '',
      'Use this volatile context for time-sensitive interpretation only.',
      '- Current date: 2026-06-11 (Thursday)',
      '- Local time: 15:42',
      '- Timezone: Africa/Johannesburg',
    ].join('\n'));
  });

  it('keeps route-level system messages stable by default', () => {
    const system = buildChatSystemMessages({
      includeGitInstructions: true,
      agentFiles: [{ path: 'AGENTS.md', content: 'Repository rules' }],
      callerSystem: 'Profile instructions',
    });
    const text = String(system);

    expect(text).toContain('Repository rules');
    expect(text).toContain('Profile instructions');
    expect(text.includes('# Runtime Context')).toBe(false);
  });

  it('appends volatile runtime context after stable system instructions before the provider call', () => {
    const runtimeContext = formatRuntimeContext({ now, timeZone: 'Africa/Johannesburg' });
    const processor = new RuntimeContextProcessor({ now, timeZone: 'Africa/Johannesburg' });
    const result = processor.processLLMRequest({
      prompt: [
        { role: 'system', content: 'Profile instructions' },
        { role: 'system', content: 'Skill search instructions' },
        { role: 'user', content: [{ type: 'text', text: 'What time is it?' }] },
      ],
    } as any);
    const prompt = result?.prompt as any[];

    expect(prompt.map(message => message.role)).toEqual(['system', 'system', 'system', 'user']);
    expect(prompt[0].content).toBe('Profile instructions');
    expect(prompt[1].content).toBe('Skill search instructions');
    expect(prompt[2].content).toBe(runtimeContext);
    expect(prompt[3].content).toEqual([{ type: 'text', text: 'What time is it?' }]);
  });

  it('does not add runtime context unless the caller opts in', () => {
    expect(buildChatSystemMessages({ includeGitInstructions: false })).toBeUndefined();
  });
});
