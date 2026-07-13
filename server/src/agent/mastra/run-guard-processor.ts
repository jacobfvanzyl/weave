import type {
  ProcessInputStepArgs,
  ProcessInputStepResult,
  Processor,
  ProcessOutputResultArgs,
} from '@mastra/core/processors';

type UnknownRecord = Record<string, unknown>;

export type RunGuardReason =
  | 'step_budget'
  | 'repeated_tool_call'
  | 'repeated_tool_failure';

export type RunGuardSnapshot = {
  version: 3;
  maxSteps: number;
  steps: number;
  toolCalls: number;
  toolFailures: number;
  maxConsecutiveRepeatedCall: number;
  maxConsecutiveRepeatedFailure: number;
  validationCalls: number;
  validationFailures: number;
  validationRecoveries: number;
  unresolvedValidationFailure: boolean;
  steeringMessages: number;
  circuitBreakerReason?: RunGuardReason;
  status: 'ok' | 'warning' | 'stopped';
  warnings: string[];
};

type RunGuardProcessorOptions = {
  maxSteps?: number;
  repeatedCallLimit?: number;
  repeatedFailureLimit?: number;
};

const defaultAgentMaxSteps = 64;
const hardAgentMaxSteps = 96;
const defaultRepeatedCallLimit = 4;
const defaultRepeatedFailureLimit = 3;

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
  const candidate = (isRecord(result) && (result.error ?? result.message)) ?? record?.error ?? textValue(result) ??
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

const validationKind = (call: unknown, result?: unknown) => {
  const args = toolArgs(call);
  const resultValue = toolResultValue(result);
  const explicit = isRecord(args) && typeof args.validation === 'string'
    ? args.validation
    : isRecord(resultValue) && typeof resultValue.validation === 'string'
    ? resultValue.validation
    : undefined;
  return explicit;
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

const toolCallId = (value: unknown) => {
  const record = payloadRecord(value);
  return typeof record?.toolCallId === 'string' ? record.toolCallId : undefined;
};

export const summarizeRunGuard = (
  steps: unknown[],
  messages: unknown[],
  options: Required<RunGuardProcessorOptions>,
  circuitBreakerReason?: RunGuardReason,
): RunGuardSnapshot => {
  let toolCalls = 0;
  let toolFailures = 0;
  let validationCalls = 0;
  let validationFailures = 0;
  let validationRecoveries = 0;
  let unresolvedValidationFailure = false;
  let previousCall: string | undefined;
  let consecutiveCall = 0;
  let maxConsecutiveRepeatedCall = 0;
  let previousFailure: string | undefined;
  let consecutiveFailure = 0;
  let maxConsecutiveRepeatedFailure = 0;

  for (const step of steps) {
    const calls = isRecord(step) && Array.isArray(step.toolCalls) ? step.toolCalls : [];
    const results = isRecord(step) && Array.isArray(step.toolResults) ? step.toolResults : [];
    const callsById = new Map<string, unknown>(
      calls.flatMap((call): Array<[string, unknown]> => {
        const id = toolCallId(call);
        return id ? [[id, call]] : [];
      }),
    );
    const resultsById = new Map<string, unknown>(
      results.flatMap((result): Array<[string, unknown]> => {
        const id = toolCallId(result);
        return id ? [[id, result]] : [];
      }),
    );

    for (const call of calls) {
      toolCalls += 1;
      const matchingResult = toolCallId(call) ? resultsById.get(toolCallId(call)!) : undefined;
      if (!matchingResult) {
        previousCall = undefined;
        consecutiveCall = 0;
        if (validationKind(call)) validationCalls += 1;
        continue;
      }
      const fingerprint = `${callFingerprint(call)}:${JSON.stringify(stableValue(toolResultValue(matchingResult)))}`;
      consecutiveCall = fingerprint === previousCall ? consecutiveCall + 1 : 1;
      previousCall = fingerprint;
      maxConsecutiveRepeatedCall = Math.max(maxConsecutiveRepeatedCall, consecutiveCall);
      if (validationKind(call)) validationCalls += 1;
    }

    for (const result of results) {
      const resultCallId = toolCallId(result);
      const call = (resultCallId ? callsById.get(resultCallId) : undefined) ??
        calls.find((candidate) => toolName(candidate) === toolName(result));
      const failed = failedResult(result);
      const validation = validationKind(call, result);
      if (validation) {
        if (failed) {
          validationFailures += 1;
          unresolvedValidationFailure = true;
        } else if (unresolvedValidationFailure) {
          validationRecoveries += 1;
          unresolvedValidationFailure = false;
        }
      }
      if (!failed) {
        previousFailure = undefined;
        consecutiveFailure = 0;
        continue;
      }
      toolFailures += 1;
      const signature = `${toolName(result)}:${normalizedFailure(result)}`;
      consecutiveFailure = signature === previousFailure ? consecutiveFailure + 1 : 1;
      previousFailure = signature;
      maxConsecutiveRepeatedFailure = Math.max(maxConsecutiveRepeatedFailure, consecutiveFailure);
    }
  }

  const warnings: string[] = [];
  if (unresolvedValidationFailure) warnings.push('latest validation is failing');
  if (toolFailures > 0) warnings.push(`${toolFailures} tool failures`);
  const reason = circuitBreakerReason;
  return {
    version: 3,
    maxSteps: options.maxSteps,
    steps: steps.length,
    toolCalls,
    toolFailures,
    maxConsecutiveRepeatedCall,
    maxConsecutiveRepeatedFailure,
    validationCalls,
    validationFailures,
    validationRecoveries,
    unresolvedValidationFailure,
    steeringMessages: messages.filter(steeringMessage).length,
    ...(reason ? { circuitBreakerReason: reason } : {}),
    status: reason ? 'stopped' : warnings.length ? 'warning' : 'ok',
    warnings,
  };
};

const circuitBreakerFor = (
  snapshot: RunGuardSnapshot,
  options: Required<RunGuardProcessorOptions>,
  stepNumber: number,
): RunGuardReason | undefined => {
  if (stepNumber >= options.maxSteps - 1) return 'step_budget';
  if (snapshot.maxConsecutiveRepeatedCall >= options.repeatedCallLimit) return 'repeated_tool_call';
  if (snapshot.maxConsecutiveRepeatedFailure >= options.repeatedFailureLimit) return 'repeated_tool_failure';
  return undefined;
};

export class RunGuardProcessor implements Processor<'weave-run-guard'> {
  readonly id = 'weave-run-guard';
  readonly name = 'Weave Run Guard';
  private readonly options: Required<RunGuardProcessorOptions>;

  constructor(options: RunGuardProcessorOptions = {}) {
    this.options = {
      maxSteps: options.maxSteps ?? getAgentMaxSteps(),
      repeatedCallLimit: options.repeatedCallLimit ?? defaultRepeatedCallLimit,
      repeatedFailureLimit: options.repeatedFailureLimit ?? defaultRepeatedFailureLimit,
    };
  }

  async processInputStep(args: ProcessInputStepArgs): Promise<ProcessInputStepResult | undefined> {
    const existingReason = args.state.circuitBreakerReason as RunGuardReason | undefined;
    const snapshot = summarizeRunGuard(args.steps, args.messages, this.options, existingReason);
    const reason = existingReason ?? circuitBreakerFor(snapshot, this.options, args.stepNumber);
    Object.assign(args.state, snapshot, reason ? { circuitBreakerReason: reason } : {});
    if (!reason) return undefined;

    if (args.state.finalResponseRequested !== true) {
      args.state.finalResponseRequested = true;
      await args.sendSignal?.({
        type: 'reactive',
        contents: reason === 'step_budget'
          ? `The execution budget is exhausted at step ${
            args.stepNumber + 1
          }. Do not call more tools. Give a structured checkpoint with objective, completed changes, current repository and validation state, decisions, blockers, and the safest continuation.`
          : reason === 'repeated_tool_call'
          ? 'The run guard detected consecutive identical tool calls without an intervening action. Stop the loop and give an evidence-based handoff.'
          : 'The run guard detected consecutive repeated failures. Stop retrying and report the exact failure plus the safest continuation.',
        attributes: { reason, step: args.stepNumber + 1 },
      });
    }
    return { toolChoice: 'none', activeTools: [] };
  }

  async processOutputResult(args: ProcessOutputResultArgs) {
    const reason = args.state.circuitBreakerReason as RunGuardReason | undefined;
    const snapshot = summarizeRunGuard(args.result.steps, args.messages, this.options, reason);
    await args.writer?.custom({ type: 'data-run-guard', data: snapshot });
    console.info('[agent-run-guard]', snapshot);
    return args.messages;
  }
}
