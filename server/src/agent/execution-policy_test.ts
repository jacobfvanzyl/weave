import { assertEquals } from 'jsr:@std/assert@1.0.19';
import {
  DefaultToolExecutionPolicy,
  getExecutionProfile,
  normalizeExecutionProfile,
  putExecutionProfile,
} from './execution-policy.ts';

Deno.test('execution profiles default to the sandboxed workspace profile', () => {
  assertEquals(normalizeExecutionProfile(undefined), 'workspace');
  assertEquals(normalizeExecutionProfile('unexpected'), 'workspace');
  assertEquals(normalizeExecutionProfile('observe'), 'observe');
  assertEquals(normalizeExecutionProfile('host'), 'host');
});

Deno.test('execution policy denies mutations in observe and asks for host mutations', () => {
  const policy = new DefaultToolExecutionPolicy();
  assertEquals(policy.decide({ profile: 'observe', toolName: 'read' }), 'allow');
  assertEquals(policy.decide({ profile: 'observe', toolName: 'bash' }), 'deny');
  assertEquals(policy.decide({ profile: 'workspace', toolName: 'bash' }), 'allow');
  assertEquals(policy.decide({ profile: 'host', toolName: 'bash' }), 'ask');
  assertEquals(policy.decide({ profile: 'host', toolName: 'read' }), 'allow');
});

Deno.test('workspace profile asks before destructive Git shell commands', () => {
  const policy = new DefaultToolExecutionPolicy();
  assertEquals(
    policy.decide({
      profile: 'workspace',
      toolName: 'exec_start',
      input: { command: 'git reset --hard HEAD~1' },
    }),
    'ask',
  );
  assertEquals(
    policy.decide({
      profile: 'workspace',
      toolName: 'exec_start',
      input: { command: 'deno task test' },
    }),
    'allow',
  );
});

Deno.test('execution profile round trips through request context', () => {
  const values = new Map<string, unknown>();
  const context = {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => values.set(key, value),
  };
  putExecutionProfile(context, 'observe');
  assertEquals(getExecutionProfile(context), 'observe');
});
