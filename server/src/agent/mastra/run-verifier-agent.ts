import { Agent } from '@mastra/core/agent';
import { z } from 'zod';

export const runVerificationSchema = z.object({
  verdict: z.enum(['pass', 'needs_evidence', 'needs_changes']),
  summary: z.string().min(1).max(2_000),
  missingEvidence: z.array(z.string()).max(20),
  unresolvedRisks: z.array(z.string()).max(20),
  requestAnotherPhase: z.boolean(),
});

export type RunVerification = z.infer<typeof runVerificationSchema>;

export const runVerifierAgent = new Agent({
  id: 'run-verifier',
  name: 'Run Verifier',
  model: 'chatgpt/codex/gpt-5.6-luna',
  tools: {},
  workspace: () => undefined,
  instructions:
    `Independently verify a coding-agent outcome from requirements, final diff evidence, validation evidence,
and unresolved risks. You never receive or infer the executor's hidden reasoning. Require concrete evidence; do not accept
activity as proof. Set requestAnotherPhase only when a small bounded follow-up could obtain missing evidence or repair a
specific issue. Return the requested structured result and nothing else.`,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const json = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export const collectVerifierEvidence = (chunks: unknown[], requirements: unknown[]) => {
  const relevant = chunks.filter((chunk) => {
    if (!isRecord(chunk) || typeof chunk.type !== 'string') return false;
    if (chunk.type.startsWith('reasoning') || chunk.type.startsWith('text-')) return false;
    const toolName = typeof chunk.toolName === 'string' ? chunk.toolName : undefined;
    return toolName === 'git_diff' || chunk.type.includes('tool-output') || chunk.type === 'tool-result' ||
      chunk.type === 'data-run-guard' || chunk.type === 'error';
  });
  return {
    requirements,
    executionEvidence: json(relevant).slice(0, 60_000),
  };
};

export const appendRunVerification = (
  stream: ReadableStream<unknown>,
  options: {
    requirements: unknown[];
    verify: (evidence: ReturnType<typeof collectVerifierEvidence>) => Promise<RunVerification>;
  },
) =>
  new ReadableStream<unknown>({
    async start(controller) {
      const reader = stream.getReader();
      const chunks: unknown[] = [];
      const terminal: unknown[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          const type = isRecord(value) ? value.type : undefined;
          if (type === 'finish' || type === 'abort') terminal.push(value);
          else controller.enqueue(value);
        }
        const suspended = chunks.some((chunk) => {
          if (!isRecord(chunk)) return false;
          return chunk.type === 'tool-approval-request' || chunk.type === 'data-tool-call-approval' ||
            chunk.type === 'tool-call-approval' || chunk.type === 'tool-call-suspended' ||
            chunk.toolName === 'ask_user';
        });
        if (suspended) {
          for (const value of terminal) controller.enqueue(value);
          controller.close();
          return;
        }
        const verification = await options.verify(collectVerifierEvidence(chunks, options.requirements));
        controller.enqueue({ type: 'data-run-verification', data: verification, transient: false });
        for (const value of terminal) controller.enqueue(value);
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
    cancel(reason) {
      return stream.cancel(reason).catch(() => undefined);
    },
  });
