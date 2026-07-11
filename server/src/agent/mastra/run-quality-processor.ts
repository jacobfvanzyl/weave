import type {
  ProcessInputStepArgs,
  ProcessInputStepResult,
  Processor,
  ProcessOutputResultArgs,
} from '@mastra/core/processors';

type UnknownRecord = Record<string, unknown>;

export type RunQualityEvaluation = 'pass' | 'warn' | 'fail';

export type RunQualitySnapshot = {
  version: 1;
  maxSteps: number;
  steps: number;
  toolCalls: number;
  toolFailures: number;
  maxRepeatedFailure: number;
  maxRepeatedCall: number;
  redundantToolCalls: number;
  validationCalls: number;
  validationFailures: number;
  restoreCommands: number;
  steeringMessages: number;
  circuitBreakerReason?: 'max_steps' | 'repeated_tool_call' | 'repeated_tool_failure' | 'excessive_tool_failures';
  evaluation: RunQualityEvaluation;
  evaluationReasons: string[];
};

type RunQualityProcessorOptions = {
  maxSteps?: number;
  repeatedCallLimit?: number;
  repeatedFailureLimit?: number;
  totalFailureLimit?: number;
};

const defaultAgentMaxSteps = 64;
const hardAgentMaxSteps = 96;
const defaultRepeatedCallLimit = 4;
const defaultRepeatedFailureLimit = 3;
const defaultTotalFailureLimit = 8;
const validationCommandPattern =
  /(?:^|\s)(?:flutter|dart|deno|npm|pnpm|yarn|bun|cargo|go)\s+(?:test|analyze|check|lint|typecheck|build)|(?:^|\s)(?:pytest|vitest|jest|tsc)(?:\s|$)/i;
const restoreCommandPattern = /(?:^|[;&|]\s*)git\s+(?:restore\b|checkout\s+--\b)/i;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const positiveInteger = (value: unknown) => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

export const getAgentMaxSteps = (env: NodeJS.ProcessEnv = process.env) =>
  Math.min(positiveInteger(env.WEAVE_AGENT_MAX_STEPS) ?? defaultAgentMaxSteps, hardAgentMaxSteps);

export const clampAgentMaxSteps = (requested: unknown, env: NodeJS.ProcessEnv = process.env) =>
  Math.min(positiveInteger(requested) ?? getAgentMaxSteps(env), hardAgentMaxSteps);

const payloadRecord = (value: unknown) => {
  if (!isRecord(value)) return undefined;
  return isRecord(value.payload) ? value.payload : value;
};

const toolName = (value: unknown) => {
  const record = payloadRecord(value);
  for (const key of ['toolName', 'name']) {
    if (typeof record?.[key] === 'string' && record[key]) return record[key] as string;
  }
  return 'tool';
};

const toolArgs = (value: unknown) => {
  const record = payloadRecord(value);
  return record?.args ?? record?.input;
};

const toolResultValue = (value: unknown) => {
  const record = payloadRecord(value);
  return record?.result ?? record?.output;
};

const textValue = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  if (typeof value.value === 'string') return value.value;
  if (typeof value.text === 'string') return value.text;
  return undefined;
};

const failedResult = (value: unknown) => {
  const record = payloadRecord(value);
  if (record?.isError === true || record?.error instanceof Error || typeof record?.error === 'string') return true;
  const result = toolResultValue(value);
  if (isRecord(result) && (result.ok === false || result.isError === true || result.error instanceof Error)) {
    return true;
  }
  const text = textValue(result);
  return Boolean(text && /(?:^|\n)ok:\s*false(?:\n|$)|(?:^|\n)(?:error|failed):\s*\S/i.test(text));
};

const normalizedFailure = (value: unknown) => {
  const record = payloadRecord(value);
  const result = toolResultValue(value);
  const candidate = (isRecord(result) && (result.error ?? result.message)) ??
    record?.error ??
    textValue(result) ??
    'failed';
  return String(candidate)
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
};

const callFingerprint = (value: unknown) => {
  try {
    return `${toolName(value)}:${JSON.stringify(stableValue(toolArgs(value)))}`;
  } catch {
    return toolName(value);
  }
};

const commandFromCall = (value: unknown) => {
  const args = toolArgs(value);
  return isRecord(args) && typeof args.command === 'string' ? args.command : undefined;
};

const steeringMessage = (message: unknown) => {
  if (!isRecord(message)) return false;
  if (message.role === 'signal') return true;
  const content = isRecord(message.content) ? message.content : undefined;
  const metadata = isRecord(message.metadata)
    ? message.metadata
    : isRecord(content?.metadata)
    ? content.metadata
    : undefined;
  return isRecord(metadata?.signal);
};

const evaluationFor = (snapshot: Omit<RunQualitySnapshot, 'evaluation' | 'evaluationReasons'>) => {
  const reasons: string[] = [];
  if (snapshot.circuitBreakerReason) reasons.push(`circuit breaker: ${snapshot.circuitBreakerReason}`);
  if (snapshot.validationFailures > 0) reasons.push(`${snapshot.validationFailures} validation failure(s)`);
  if (snapshot.restoreCommands > 2) reasons.push(`${snapshot.restoreCommands} restore command(s)`);
  if (snapshot.redundantToolCalls > 12) reasons.push(`${snapshot.redundantToolCalls} redundant tool call(s)`);
  if (snapshot.steeringMessages > 1) reasons.push(`${snapshot.steeringMessages} steering message(s)`);
  if (snapshot.toolFailures > 0 && reasons.length === 0) reasons.push(`${snapshot.toolFailures} tool failure(s)`);

  const evaluation: RunQualityEvaluation = snapshot.circuitBreakerReason || snapshot.validationFailures > 0
    ? 'fail'
    : reasons.length > 0
    ? 'warn'
    : 'pass';
  return { evaluation, evaluationReasons: reasons };
};

export const summarizeRunQuality = (
  steps: unknown[],
  messages: unknown[],
  options: Required<RunQualityProcessorOptions>,
  circuitBreakerReason?: RunQualitySnapshot['circuitBreakerReason'],
): RunQualitySnapshot => {
  const calls = steps.flatMap((step) => isRecord(step) && Array.isArray(step.toolCalls) ? step.toolCalls : []);
  const results = steps.flatMap((step) => isRecord(step) && Array.isArray(step.toolResults) ? step.toolResults : []);
  const failureCounts = new Map<string, number>();
  let toolFailures = 0;
  let validationFailures = 0;

  for (const result of results) {
    if (!failedResult(result)) continue;
    toolFailures += 1;
    const signature = `${toolName(result)}:${normalizedFailure(result)}`;
    failureCounts.set(signature, (failureCounts.get(signature) ?? 0) + 1);
    const matchingCall = calls.find((call) => {
      const callRecord = payloadRecord(call);
      const resultRecord = payloadRecord(result);
      return callRecord?.toolCallId && callRecord.toolCallId === resultRecord?.toolCallId;
    });
    if (validationCommandPattern.test(commandFromCall(matchingCall) ?? '')) validationFailures += 1;
  }

  const fingerprints = new Map<string, number>();
  let validationCalls = 0;
  let restoreCommands = 0;
  for (const call of calls) {
    const fingerprint = callFingerprint(call);
    fingerprints.set(fingerprint, (fingerprints.get(fingerprint) ?? 0) + 1);
    const command = commandFromCall(call) ?? '';
    if (validationCommandPattern.test(command)) validationCalls += 1;
    if (restoreCommandPattern.test(command)) restoreCommands += 1;
  }

  const base = {
    version: 1 as const,
    maxSteps: options.maxSteps,
    steps: steps.length,
    toolCalls: calls.length,
    toolFailures,
    maxRepeatedFailure: Math.max(0, ...failureCounts.values()),
    maxRepeatedCall: Math.max(0, ...fingerprints.values()),
    redundantToolCalls: [...fingerprints.values()].reduce((total, count) => total + Math.max(0, count - 1), 0),
    validationCalls,
    validationFailures,
    restoreCommands,
    steeringMessages: messages.filter(steeringMessage).length,
    ...(circuitBreakerReason ? { circuitBreakerReason } : {}),
  };
  return { ...base, ...evaluationFor(base) };
};

const circuitBreakerFor = (
  snapshot: RunQualitySnapshot,
  options: Required<RunQualityProcessorOptions>,
  stepNumber: number,
): RunQualitySnapshot['circuitBreakerReason'] | undefined => {
  if (stepNumber >= options.maxSteps - 1) return 'max_steps';
  if (snapshot.maxRepeatedCall >= options.repeatedCallLimit) return 'repeated_tool_call';
  if (snapshot.maxRepeatedFailure >= options.repeatedFailureLimit) return 'repeated_tool_failure';
  if (snapshot.toolFailures >= options.totalFailureLimit) return 'excessive_tool_failures';
  return undefined;
};

export class RunQualityProcessor implements Processor<'weave-run-quality'> {
  readonly id = 'weave-run-quality';
  readonly name = 'Weave Run Quality Guard';
  private readonly options: Required<RunQualityProcessorOptions>;

  constructor(options: RunQualityProcessorOptions = {}) {
    this.options = {
      maxSteps: options.maxSteps ?? getAgentMaxSteps(),
      repeatedCallLimit: options.repeatedCallLimit ?? defaultRepeatedCallLimit,
      repeatedFailureLimit: options.repeatedFailureLimit ?? defaultRepeatedFailureLimit,
      totalFailureLimit: options.totalFailureLimit ?? defaultTotalFailureLimit,
    };
  }

  async processInputStep(args: ProcessInputStepArgs): Promise<ProcessInputStepResult | undefined> {
    const existingReason = args.state.circuitBreakerReason as RunQualitySnapshot['circuitBreakerReason'] | undefined;
    const snapshot = summarizeRunQuality(args.steps, args.messages, this.options, existingReason);
    const reason = existingReason ?? circuitBreakerFor(snapshot, this.options, args.stepNumber);
    Object.assign(args.state, snapshot, reason ? { circuitBreakerReason: reason } : {});
    if (!reason) return undefined;

    if (args.state.finalResponseRequested !== true) {
      args.state.finalResponseRequested = true;
      await args.sendSignal?.({
        type: 'reactive',
        contents: reason === 'max_steps'
          ? `This is the final step (${
            args.stepNumber + 1
          } of ${this.options.maxSteps}). Do not call tools. Give the user a concise, honest handoff with completed work, failed validation, and remaining risks.`
          : reason === 'repeated_tool_call'
          ? `The run-quality circuit breaker fired because the same successful tool call is repeating without progress. Do not call tools. Stop repeating work and give the user a concise, honest handoff with what was learned and the safest next action.`
          : `The run-quality circuit breaker fired because tool failures are repeating. Do not call tools. Stop retrying, state the repeated failure, and give the user a concise, honest handoff with the safest next action.`,
        attributes: { reason, step: args.stepNumber + 1 },
      });
    }

    return { toolChoice: 'none', activeTools: [] };
  }

  async processOutputResult(args: ProcessOutputResultArgs) {
    const reason = args.state.circuitBreakerReason as RunQualitySnapshot['circuitBreakerReason'] | undefined;
    const snapshot = summarizeRunQuality(args.result.steps, args.messages, this.options, reason);
    await args.writer?.custom({ type: 'data-run-quality', data: snapshot });
    console.info('[agent-run-quality]', snapshot);
    return args.messages;
  }
}
