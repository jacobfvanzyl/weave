import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1.0.19';
import { appendRunVerification, collectVerifierEvidence } from './run-verifier-agent.ts';

Deno.test('verifier evidence excludes executor reasoning but retains validation and diff evidence', () => {
  const evidence = collectVerifierEvidence([
    { type: 'reasoning-delta', delta: 'private chain' },
    { type: 'tool-result', toolName: 'git_diff', result: 'diff --git a/a b/a' },
    { type: 'tool-output-available', toolName: 'bash', output: { validation: 'test', ok: true } },
  ], [{ text: 'requirement' }]);
  assertEquals(evidence.executionEvidence.includes('private chain'), false);
  assertStringIncludes(evidence.executionEvidence, 'git_diff');
  assertStringIncludes(evidence.executionEvidence, 'validation');
});

Deno.test('verification event is emitted before the terminal finish chunk', async () => {
  const stream = appendRunVerification(
    new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'text-delta', delta: 'done' });
        controller.enqueue({ type: 'finish' });
        controller.close();
      },
    }),
    {
      requirements: [],
      verify: async () => ({
        verdict: 'pass',
        summary: 'verified',
        missingEvidence: [],
        unresolvedRisks: [],
        requestAnotherPhase: false,
      }),
    },
  );
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assertEquals(chunks.map((chunk: any) => chunk.type), ['text-delta', 'data-run-verification', 'finish']);
});
