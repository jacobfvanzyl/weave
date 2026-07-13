import { assertEquals } from 'jsr:@std/assert@1.0.19';
import { AgentRunCoordinator } from './run-coordinator.ts';
import { MastraAgentService } from './service.ts';
import type { AgentRunRecordV1 } from './run-repository.ts';

const record: AgentRunRecordV1 = {
  version: 1,
  runId: 'run-1',
  resourceId: 'owner-1',
  threadId: 'thread-1',
  mastraRunId: 'mastra-1',
  status: 'running',
  executionProfile: 'workspace',
  metadata: {},
  lastSequence: 3,
  startedAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
};

Deno.test('restart replay is ordered, sequence based, and marks an orphaned run interrupted without executing tools', async () => {
  let interrupted = 0;
  let mutationExecutions = 0;
  const repository = {
    latest: async () => record,
    interrupt: async () => {
      interrupted += 1;
      return { ...record, status: 'interrupted' as const };
    },
    events: async (_runId: string, afterSequence: number) =>
      [
        {
          version: 1,
          runId: 'run-1',
          sequence: 1,
          eventId: '1',
          eventType: 'tool-call',
          data: { type: 'tool-call', toolCallId: 'mutation-1' },
          createdAt: '',
        },
        {
          version: 1,
          runId: 'run-1',
          sequence: 2,
          eventId: '2',
          eventType: 'tool-result',
          data: { type: 'tool-result', toolCallId: 'mutation-1', result: 'ok' },
          createdAt: '',
        },
        {
          version: 1,
          runId: 'run-1',
          sequence: 3,
          eventId: '3',
          eventType: 'finish',
          data: { type: 'finish' },
          createdAt: '',
        },
      ].filter((event) => event.sequence > afterSequence),
    executeMutation: () => mutationExecutions += 1,
  };
  const service = new MastraAgentService(
    {} as any,
    new AgentRunCoordinator(),
    undefined,
    undefined,
    undefined,
    undefined,
    repository as any,
  );
  const stream = await service.replayChatRun('owner-1', 'thread-1', 1);
  const chunks = [];
  for await (const chunk of stream!) chunks.push(chunk);
  assertEquals(chunks, [
    { type: 'tool-result', toolCallId: 'mutation-1', result: 'ok' },
    { type: 'finish' },
  ]);
  assertEquals(interrupted, 1);
  assertEquals(mutationExecutions, 0);
});
