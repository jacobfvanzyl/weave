import { describe, expect, it } from 'vitest';
import {
  buildChatSystemMessages,
  formatAvailableSkills,
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

  it('adds bounded available-skill guidance without eager skill bodies', () => {
    const skills = Array.from({ length: 31 }, (_, index) => ({
      name: `skill-${index.toString().padStart(2, '0')}`,
      source: index % 2 === 0 ? 'project' as const : 'global' as const,
      path: `.weave/skills/skill-${index.toString().padStart(2, '0')}/SKILL.md`,
      description: `Description for skill ${index}`,
      content: 'FULL SKILL BODY SHOULD NOT BE INCLUDED',
    }));
    const system = buildChatSystemMessages({
      includeGitInstructions: false,
      skillSummaries: skills,
      callerSystem: 'Profile instructions',
    });
    const text = String(system);

    expect(text).toContain('# Available Skills');
    expect(text).toContain('call load_skill with its exact name before acting');
    expect(text).toContain('call search_skills with focused keywords');
    expect(text).toContain('If the user explicitly mentions $skill-name');
    expect(text).toContain('- skill-00 (project, .weave/skills/skill-00/SKILL.md): Description for skill 0');
    expect(text).toContain('- skill-29 (global, .weave/skills/skill-29/SKILL.md): Description for skill 29');
    expect(text).toContain('- 1 more skill(s) are available. Use search_skills to find them.');
    expect(text.includes('skill-30')).toBe(false);
    expect(text.includes('FULL SKILL BODY SHOULD NOT BE INCLUDED')).toBe(false);
    expect(text).toContain('Profile instructions');
  });

  it('omits available-skill guidance when there are no skills', () => {
    expect(formatAvailableSkills([])).toBeUndefined();
  });
});
