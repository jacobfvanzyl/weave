import { assertEquals, assertExists } from 'jsr:@std/assert@1.0.19';
import {
  type PortalPty,
  type PortalPtyExitEvent,
  type PortalPtySpawner,
  PortalTerminalHost,
  startTerminalControlServer,
  type TerminalHostEvent,
} from './terminal.ts';

class FakePty implements PortalPty {
  pid = 4242;
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  closed = false;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PortalPtyExitEvent) => void>();

  write(data: string) {
    this.writes.push(data);
  }

  resize(cols: number, rows: number) {
    this.resizes.push({ cols, rows });
  }

  close() {
    this.closed = true;
  }

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: PortalPtyExitEvent) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  emitData(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(event: PortalPtyExitEvent = { exitCode: 0 }) {
    for (const listener of this.exitListeners) listener(event);
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withHost = async (
  callback: (context: {
    cwd: string;
    host: PortalTerminalHost;
    ptys: FakePty[];
  }) => Promise<void>,
) => {
  const cwd = await Deno.makeTempDir({ prefix: 'weave-terminal-' });
  const realCwd = await Deno.realPath(cwd);
  const ptys: FakePty[] = [];
  const spawner: PortalPtySpawner = () => {
    const pty = new FakePty();
    ptys.push(pty);
    return pty;
  };
  const host = new PortalTerminalHost({
    config: {},
    spawner,
    outputBatchMs: 1,
    replayLimitBytes: 1024,
    env: { SHELL: '/bin/test-shell' },
  });

  try {
    await callback({ cwd: realCwd, host, ptys });
  } finally {
    host.dispose();
    await Deno.remove(cwd, { recursive: true });
  }
};

Deno.test('PortalTerminalHost reuses sessions and replays output', async () =>
  withHost(async ({ cwd, host, ptys }) => {
    const firstEvents: TerminalHostEvent[] = [];
    await host.handleClientMessage('client-1', {
      type: 'start',
      kind: 'demiplane',
      terminalId: 'term-1',
      planeId: 'plane-1',
      demiplaneId: 'demiplane-1',
      workspacePath: cwd,
      cols: 100,
      rows: 30,
    }, (event) => firstEvents.push(event));

    assertEquals(ptys.length, 1);
    assertEquals(firstEvents[0], {
      type: 'started',
      terminalId: 'term-1',
      demiplaneId: 'demiplane-1',
      sessionId: (firstEvents[0] as any).sessionId,
      cwd,
      pid: 4242,
      cols: 100,
      rows: 30,
    });

    ptys[0].emitData('hello');
    await delay(5);
    assertEquals(firstEvents.at(-1), {
      type: 'output',
      terminalId: 'term-1',
      demiplaneId: 'demiplane-1',
      data: 'hello',
    });

    const secondEvents: TerminalHostEvent[] = [];
    await host.handleClientMessage('client-2', {
      type: 'start',
      kind: 'demiplane',
      terminalId: 'term-1',
      planeId: 'plane-1',
      demiplaneId: 'demiplane-1',
      workspacePath: cwd,
      cols: 120,
      rows: 30,
    }, (event) => secondEvents.push(event));

    assertEquals(ptys.length, 1);
    assertEquals(ptys[0].resizes, [{ cols: 120, rows: 30 }]);
    assertEquals(secondEvents[0]?.type, 'started');
    assertEquals(secondEvents[1], {
      type: 'replay',
      terminalId: 'term-1',
      demiplaneId: 'demiplane-1',
      data: 'hello',
    });
  }));

Deno.test('PortalTerminalHost routes input, resize, detach, close, and exit', async () =>
  withHost(async ({ cwd, host, ptys }) => {
    const events: TerminalHostEvent[] = [];
    await host.handleClientMessage('client-1', {
      type: 'start',
      kind: 'general',
      terminalId: 'general-1',
      cwd,
      cols: 90,
      rows: 24,
    }, (event) => events.push(event));

    assertExists(ptys[0]);
    await host.handleClientMessage(
      'client-1',
      { type: 'input', terminalId: 'general-1', data: 'pwd\r' },
      (event) => events.push(event),
    );
    await host.handleClientMessage(
      'client-1',
      { type: 'resize', terminalId: 'general-1', cols: 132, rows: 40 },
      (event) => events.push(event),
    );
    assertEquals(ptys[0].writes, ['pwd\r']);
    assertEquals(ptys[0].resizes, [{ cols: 132, rows: 40 }]);

    await host.handleClientMessage(
      'client-1',
      { type: 'detach', terminalId: 'general-1' },
      (event) => events.push(event),
    );
    ptys[0].emitData('after detach');
    await delay(5);
    assertEquals(events.some((event) => event.type === 'output' && event.data === 'after detach'), false);

    await host.handleClientMessage(
      'client-2',
      { type: 'start', kind: 'general', terminalId: 'general-1', cwd },
      (event) => events.push(event),
    );
    await host.handleClientMessage(
      'client-2',
      { type: 'close', terminalId: 'general-1' },
      (event) => events.push(event),
    );
    assertEquals(ptys[0].closed, true);
    ptys[0].emitExit({ exitCode: 0 });
    assertEquals(events.at(-1), {
      type: 'exit',
      terminalId: 'general-1',
      demiplaneId: undefined,
      exitCode: 0,
      signal: undefined,
    });
  }));

Deno.test('local terminal control requires auth and shuts down', async () =>
  withHost(async ({ host }) => {
    let shutdownCalled = false;
    const server = startTerminalControlServer({
      host,
      hostname: '127.0.0.1',
      port: 0,
      token: 'test-token',
      metadata: { portalId: 'portal_test' },
      onShutdown: () => {
        shutdownCalled = true;
      },
    });

    const baseUrl = `http://127.0.0.1:${server.addr.port}`;
    try {
      assertEquals((await fetch(`${baseUrl}/health`)).status, 401);
      const health = await fetch(`${baseUrl}/health?token=test-token`);
      assertEquals(health.status, 200);
      assertEquals(await health.json(), { ok: true, portalId: 'portal_test' });

      const shutdown = await fetch(`${baseUrl}/shutdown?token=test-token`, { method: 'POST' });
      assertEquals(shutdown.status, 200);
      await delay(25);
      assertEquals(shutdownCalled, true);
    } finally {
      await server.shutdown().catch(() => undefined);
    }
  }));
