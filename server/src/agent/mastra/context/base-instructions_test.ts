import instructions from './base-instructions.md' with { type: 'text' };

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const assertIncludes = (text: string, expected: string) => {
  assert(text.includes(expected), `Expected base instructions to include: ${expected}`);
};

const assertExcludes = (text: string, expected: string) => {
  assert(!text.includes(expected), `Expected base instructions to exclude: ${expected}`);
};

Deno.test('base instructions include centralized tool communication contract', () => {
  assertIncludes(instructions, 'Tool communication:');
  assertIncludes(
    instructions,
    'Treat tool names, arguments, schemas, hashes, offsets, provider or adapter details, tool IDs, and result-shaping details as internal by default.',
  );
  assertIncludes(
    instructions,
    'describe outcomes, evidence, decisions, and next steps instead of narrating tool mechanics',
  );
  assertIncludes(instructions, 'I checked current sources and the docs say');
  assertIncludes(instructions, 'I inspected the file and found');
  assertIncludes(instructions, 'The worktree has uncommitted changes.');
  assertIncludes(instructions, 'I need one product decision before this is safe.');
  assertIncludes(instructions, 'Do not announce routine reads or edits');
  assertIncludes(instructions, 'After the same failure twice, stop repeating that approach');
  assertIncludes(instructions, 'Stop calling tools and give an honest final handoff');
  assertExcludes(instructions, 'proposal buffer mechanics');
  assertExcludes(instructions, 'proposal_start');
});
