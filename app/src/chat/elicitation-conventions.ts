// What the app reads in a form elicitation beyond what ACP defines, in one place: the free text
// an agent's question carries beside its options. ACP has no such field; the adapters ask for
// one as a string property of its own, each in its own shape, and read the answer their own way.
// None is required: a field that follows neither convention stays a field of its own, as a
// client that knew none of them would draw it. The TUI's equivalent is `tui/src/conventions.rs`
// (`companion_of`), and the two must agree, so both clients send the same answer for the same
// choices.
//
// | Convention | Used by |
// | --- | --- |
// | a string without options, titled exactly "Other", keyed `<choice>_custom`: its text answers in place of a single-select's pick, or joins a multi-select's picks | claude-agent-acp 0.97.0 (`AskUserQuestion`) |
// | a string without options whose `_meta.codex` has `role: "user_note"` and a `questionId` naming a choice: a note sent with the pick, "None of the above" included | codex-acp 2.3.0 (`request_user_input`; the note's key may carry a numeric suffix on a collision, `<id>_note1`, so it's known by `_meta`) |
//
// A choice is a single-select string (`oneOf` or `enum`) or a multi-select array. A companion
// that is itself required, or a choice's second, stays a field of its own.
import type { ElicitationContentValue, ElicitationPropertySchema, ElicitationSchema } from '@/host/protocol';

/** A choice's free-text companion: the field the agent asked for it as, and how it goes with the pick. */
export type Companion = {
  key: string;
  /** `replaces`: Claude's Other, which answers in place of a pick or joins a multi-select's. `note`: Codex's, sent with the pick. */
  kind: 'replaces' | 'note';
};

export type FormValues = Partial<Record<string, ElicitationContentValue>>;
export type FormContent = Record<string, ElicitationContentValue>;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** A string property's options are declared, by `oneOf` or `enum`. */
const hasOptions = (property: ElicitationPropertySchema) => {
  const string = property as { oneOf?: unknown; enum?: unknown };
  return string.oneOf != null || string.enum != null;
};

/** A single-select: a string with options. */
export const isSingleChoice = (property: ElicitationPropertySchema | undefined) =>
  property?.type === 'string' && hasOptions(property);

/** A choice: a single-select, or a multi-select array. */
export const isChoice = (property: ElicitationPropertySchema | undefined) =>
  isSingleChoice(property) || property?.type === 'array';

/** The choice `name` is the companion of, and how, where it follows one of the conventions above. */
function companionOf(
  name: string,
  property: ElicitationPropertySchema,
  properties: Record<string, ElicitationPropertySchema>,
): { choice: string; kind: Companion['kind'] } | undefined {
  if (property.type !== 'string' || hasOptions(property)) return undefined;
  const isChoiceKey = (key: string) => key !== name && Object.hasOwn(properties, key) && isChoice(properties[key]);
  // claude-agent-acp: `question_0_custom`, titled "Other", beside `question_0`.
  if ((property as { title?: unknown }).title === 'Other' && name.endsWith('_custom')) {
    const choice = name.slice(0, -'_custom'.length);
    if (isChoiceKey(choice)) return { choice, kind: 'replaces' };
  }
  // codex-acp: `_meta.codex = { questionId, role: "user_note" }`.
  const codex = record(record((property as { _meta?: unknown })._meta)?.codex);
  if (codex?.role === 'user_note' && typeof codex.questionId === 'string' && isChoiceKey(codex.questionId)) {
    return { choice: codex.questionId, kind: 'note' };
  }
  return undefined;
}

/** Each choice's companion, by the choice's key; the first in key order where a choice has several. */
export function formCompanions(schema: ElicitationSchema): Map<string, Companion> {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const companions = new Map<string, Companion>();
  for (const [name, property] of Object.entries(properties)) {
    if (required.has(name)) continue;
    const found = companionOf(name, property, properties);
    if (found && !companions.has(found.choice)) companions.set(found.choice, { key: name, kind: found.kind });
  }
  return companions;
}

/** What was typed, unless it is empty after trimming: blank text is never sent. */
export const typedText = (value: ElicitationContentValue | undefined) =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

/**
 * The answer to send: the fields the agent asked for, filled as each adapter reads them.
 * `values` holds every field's pick or typed text, companions' too, and `otherChosen` the
 * single-selects whose Claude Other is the pick. A field without a companion is sent as it is.
 *
 * - Claude's single-select: the picked option, or Other's text when Other is chosen, never both.
 * - Claude's multi-select: the picks, when there are any, and Other's text beside them.
 * - Codex's: the pick, and the note beside it.
 */
export function formAnswer(
  schema: ElicitationSchema,
  companions: ReadonlyMap<string, Companion>,
  values: FormValues,
  otherChosen: ReadonlySet<string>,
): FormContent {
  const companionKeys = new Set([...companions.values()].map(({ key }) => key));
  const content: FormContent = {};
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (companionKeys.has(name)) continue;
    const value = values[name];
    const companion = companions.get(name);
    if (!companion) {
      if (value !== undefined) content[name] = value;
      continue;
    }
    const text = typedText(values[companion.key]);
    if (companion.kind === 'replaces' && property.type === 'string') {
      if (otherChosen.has(name)) {
        if (text !== undefined) content[companion.key] = text;
      } else if (value !== undefined) {
        content[name] = value;
      }
      continue;
    }
    if (companion.kind === 'replaces') {
      if (Array.isArray(value) && value.length > 0) content[name] = value;
    } else if (value !== undefined) {
      content[name] = value;
    }
    if (text !== undefined) content[companion.key] = text;
  }
  return content;
}

/** Whether the choice `name` is answered by its Claude Other, which then counts as one of its picks. */
export const answeredByOther = (name: string, companions: ReadonlyMap<string, Companion>, content: FormContent) => {
  const companion = companions.get(name);
  return companion?.kind === 'replaces' && content[companion.key] !== undefined;
};
