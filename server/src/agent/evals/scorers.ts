import { createScorer } from '@mastra/core/evals';
import { evalTaskV1Schema, evalTrialV1Schema } from './schema.ts';

const trialScorer = (
  id: string,
  description: string,
  score: (output: typeof evalTrialV1Schema._output) => number,
) =>
  createScorer({
    id,
    description,
    type: { input: evalTaskV1Schema, output: evalTrialV1Schema },
  }).generateScore(({ run }) => score(run.output));

export const evalTrialScorers = [
  trialScorer(
    'weave-outcome',
    'Scores whether the task met all configured outcome graders.',
    (output) => output.passed ? 1 : 0,
  ),
  trialScorer(
    'weave-validation',
    'Scores whether the final authoritative validation passed.',
    (output) => output.validationPassed ? 1 : 0,
  ),
  trialScorer(
    'weave-no-harm',
    'Scores whether the trial stayed within its permitted side effects.',
    (output) => output.noHarm ? 1 : 0,
  ),
  trialScorer(
    'weave-grader-evidence',
    'Scores whether every grader retained evidence and passed.',
    (output) => output.graderEvidence.length > 0 && output.graderEvidence.every((item) => item.passed) ? 1 : 0,
  ),
];
