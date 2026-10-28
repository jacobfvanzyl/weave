import { describe, expect, it } from 'vitest';
import type { ElicitationSchema } from '@/host/protocol';
import { formCompanions } from './elicitation-conventions';

describe('a choice\'s free-text companion', () => {
  it('is Claude\'s Other or Codex\'s note, and anything else stays a field of its own', () => {
    const schema: ElicitationSchema = {
      type: 'object',
      properties: {
        many: { type: 'array', items: { anyOf: [{ const: 'a', title: 'A' }] } },
        many_custom: { type: 'string', title: 'Other' },
        name: { type: 'string', title: 'Name' },
        name_custom: { type: 'string', title: 'Other' },
        pick: { type: 'string', oneOf: [{ const: 'a', title: 'A' }] },
        pick_custom: { type: 'string', title: 'Other' },
        // A choice's second companion, and one with options, aren't.
        pick_note1: { type: 'string', _meta: { codex: { questionId: 'pick', role: 'user_note' } } },
        pick_other: { type: 'string', title: 'Other', enum: ['x'] },
        // Codex's note is known by its `_meta`, whatever its key.
        single: { type: 'string', enum: ['a'] },
        single_note1: { type: 'string', _meta: { codex: { questionId: 'single', role: 'user_note' } } },
        stray_note: { type: 'string', _meta: { codex: { questionId: 'missing', role: 'user_note' } } },
        // Nor is a required one.
        wanted: { type: 'string', enum: ['a'] },
        wanted_custom: { type: 'string', title: 'Other' },
      },
      required: ['wanted_custom'],
    };
    expect(Object.fromEntries(formCompanions(schema))).toEqual({
      many: { key: 'many_custom', kind: 'replaces' },
      pick: { key: 'pick_custom', kind: 'replaces' },
      single: { key: 'single_note1', kind: 'note' },
    });
  });
});
