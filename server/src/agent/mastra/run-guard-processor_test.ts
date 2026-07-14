import { assertEquals } from 'jsr:@std/assert@1.0.19';
import { RunGuardProcessor, summarizeRunGuard } from './run-guard-processor.ts';

const options = { maxSteps: 10, repeatedCallLimit: 3, repeatedFailureLimit: 2 };
const call = (id: string, command: string, validation?: string) => ({
  toolCallId: id,
  toolName: 'bash',
  args: { command, ...(validation ? { validation } : {}) },
});
const result = (id: string, ok: boolean, state?: string) => ({
  toolCallId: id,
  toolName: 'bash',
  result: { ok, ...(state ? { state } : {}) },
});

Deno.test('run guard counts only consecutive identical calls', () => {
  const snapshot = summarizeRunGuard(
    [
      { toolCalls: [call('1', 'git status')], toolResults: [result('1', true)] },
      { toolCalls: [call('2', 'git status')], toolResults: [result('2', true)] },
      { toolCalls: [call('3', 'printf change')], toolResults: [result('3', true)] },
      { toolCalls: [call('4', 'git status')], toolResults: [result('4', true)] },
    ],
    [],
    options,
  );
  assertEquals(snapshot.maxConsecutiveRepeatedCall, 2);
});

Deno.test('run guard treats a passing validation after failure as recovered', () => {
  const snapshot = summarizeRunGuard(
    [
      { toolCalls: [call('1', 'pnpm test', 'test')], toolResults: [result('1', false)] },
      { toolCalls: [call('2', 'pnpm test', 'test')], toolResults: [result('2', true)] },
    ],
    [],
    options,
  );
  assertEquals(snapshot.validationFailures, 1);
  assertEquals(snapshot.validationRecoveries, 1);
  assertEquals(snapshot.unresolvedValidationFailure, false);
  assertEquals(snapshot.status, 'warning');
});

Deno.test('run guard permits an identical observation when its state changes', () => {
  const snapshot = summarizeRunGuard(
    [
      { toolCalls: [call('1', 'git status')], toolResults: [result('1', true, 'clean')] },
      { toolCalls: [call('2', 'git status')], toolResults: [result('2', true, 'modified')] },
      { toolCalls: [call('3', 'git status')], toolResults: [result('3', true, 'clean')] },
    ],
    [],
    options,
  );
  assertEquals(snapshot.maxConsecutiveRepeatedCall, 1);
});

Deno.test('run guard does not treat a provider retry without a tool result as progress failure', () => {
  const snapshot = summarizeRunGuard(
    [
      { toolCalls: [call('1', 'git status')], toolResults: [] },
      { toolCalls: [call('2', 'git status')], toolResults: [] },
      { toolCalls: [call('3', 'git status')], toolResults: [] },
    ],
    [],
    options,
  );
  assertEquals(snapshot.maxConsecutiveRepeatedCall, 0);
  assertEquals(snapshot.toolFailures, 0);
});

Deno.test('run guard stops a genuine consecutive no-progress loop', async () => {
  const processor = new RunGuardProcessor(options);
  const sent: unknown[] = [];
  const response = await processor.processInputStep({
    stepNumber: 2,
    steps: [
      { toolCalls: [call('1', 'git status')], toolResults: [result('1', true)] },
      { toolCalls: [call('2', 'git status')], toolResults: [result('2', true)] },
      { toolCalls: [call('3', 'git status')], toolResults: [result('3', true)] },
    ],
    messages: [],
    state: {},
    sendSignal: (value: unknown) => {
      sent.push(value);
    },
  } as never);
  assertEquals(response, { toolChoice: 'none', activeTools: [] });
  assertEquals(sent.length, 1);
});
