import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { AgentRuntimeManager } from './runtime.ts';

Deno.test('Agent runtime attachment reports process exit and bounded diagnostics', async () => {
  let stdout!: ReadableStreamDefaultController<Uint8Array>;
  let stderr!: ReadableStreamDefaultController<Uint8Array>;
  let finishProcess!: (status: {
    success: boolean;
    code: number;
    signal?: string;
  }) => void;
  const status = new Promise<{
    success: boolean;
    code: number;
    signal?: string;
  }>((resolve) => {
    finishProcess = resolve;
  });
  const runtime = new AgentRuntimeManager(
    [{ id: 'fake', name: 'Fake', command: 'fake' }],
    {
      resolveWorkspace: () => Promise.resolve({ workspaceId: 'workspace-1', path: '/workspace' }),
      spawn: () => ({
        stdin: new WritableStream<Uint8Array>(),
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            stdout = controller;
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            stderr = controller;
          },
        }),
        status,
        kill: () => undefined,
      }),
    },
  );
  const attachment = await runtime.attach({
    agentId: 'fake',
    workspaceId: 'workspace-1',
    principalId: 'local',
    transport: 'stdio',
  });
  const reader = attachment.messages.getReader();

  stdout.enqueue(new TextEncoder().encode('not-json\n'));
  stdout.close();
  stderr.enqueue(new TextEncoder().encode('provider diagnostic'));
  stderr.close();
  finishProcess({ success: false, code: 9, signal: 'SIGKILL' });

  await assertRejects(() => reader.read(), SyntaxError);
  const exit = await attachment.finished;
  assertEquals(exit.success, false);
  assertEquals(exit.code, 9);
  assertEquals(exit.signal, 'SIGKILL');
  assertEquals(exit.stderrTail, 'provider diagnostic');
  assertEquals(typeof exit.error, 'string');
  reader.releaseLock();
});
