const bytes = (text: string) => new TextEncoder().encode(text);
import { test } from './test-support.ts';
import { assertEquals, assertRejects } from './test-support.ts';
import type { TerminalNotification } from '@weave/product-protocol';
import { InMemoryTerminalExecution, PortalTerminalError, TerminalAccess } from './terminals.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class CaptureAfterReleaseBackend extends InMemoryTerminalExecution {
  #release?: () => void;

  override async capture(terminalId: string) {
    await new Promise<void>((resolve) => {
      this.#release = resolve;
    });
    return await super.capture(terminalId);
  }

  releaseCapture() {
    this.#release?.();
  }
}

class FrozenCaptureBackend extends InMemoryTerminalExecution {
  #release?: () => void;

  override async capture(terminalId: string) {
    const frozen = await super.capture(terminalId);
    await new Promise<void>((resolve) => {
      this.#release = resolve;
    });
    return frozen;
  }

  releaseCapture() {
    this.#release?.();
  }
}

const createFixture = (options: { retentionLimitBytes?: number; attachmentQueueLimitBytes?: number } = {}) => {
  const backend = new InMemoryTerminalExecution();
  const service = new TerminalAccess({
    backend,
    resolveWorkspace: (executionContextId) =>
      executionContextId === 'workspace-1' ? { executionContextId, path: '/workspace/one' } : undefined,
    ...options,
  });
  return { backend, service };
};

test('TerminalAccess creates, lists, snapshots, and reconnects persistent terminals', async () => {
  const { backend, service } = createFixture();
  const connection = service.openSession('connection-1', () => undefined);
  try {
    const created = await connection.request('terminal.create', {
      executionContextId: 'workspace-1',
      cols: 100,
      rows: 30,
    });
    assertEquals(created.terminal.executionContextId, 'workspace-1');
    assertEquals(created.terminal.status, 'running');
    assertEquals(created.terminal.cols, 100);
    assertEquals(
      (await connection.request('terminal.list', {
        executionContextId: 'workspace-1',
      })).terminals.map(({ terminalId }) => terminalId),
      [created.terminal.terminalId],
    );

    backend.setCapture(created.terminal.terminalId, bytes('$ printf ready\r\nready\r\n'));
    const first = await connection.request('terminal.snapshot', {
      executionContextId: 'workspace-1',
      terminalId: created.terminal.terminalId,
    });
    assertEquals(first.snapshot.data, bytes('$ printf ready\r\nready\r\n'));

    await service.close();
    const reopened = new TerminalAccess({
      backend,
      resolveWorkspace: () => ({ executionContextId: 'workspace-1', path: '/workspace/one' }),
    });
    const reconnect = reopened.openSession('connection-2', () => undefined);
    const afterRestart = await reconnect.request('terminal.snapshot', {
      executionContextId: 'workspace-1',
      terminalId: created.terminal.terminalId,
    });
    assertEquals(afterRestart.snapshot.data, bytes('$ printf ready\r\nready\r\n'));
    assertEquals(afterRestart.snapshot.generation === first.snapshot.generation, false);
    reconnect.close();
    await reopened.close();
  } finally {
    connection.close();
    await service.close();
  }
});

test('TerminalAccess allows shared writers and read-only observers', async () => {
  const { backend, service } = createFixture();
  const controlNotifications: TerminalNotification[] = [];
  const observerNotifications: TerminalNotification[] = [];
  const controller = service.openSession('controller', (event) => controlNotifications.push(event));
  const observer = service.openSession('observer', (event) => observerNotifications.push(event));
  try {
    const terminal = (await controller.request('terminal.create', {
      executionContextId: 'workspace-1',
    })).terminal;
    const controlled = await controller.request('terminal.attach', {
      executionContextId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'shared',
    });
    const observed = await observer.request('terminal.attach', {
      executionContextId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'observe',
    });
    assertEquals(controlled.attachment.mode, 'shared');
    assertEquals(observed.attachment.mode, 'observe');

    const competitor = service.openSession('competitor', () => undefined);
    await competitor.request('terminal.attach', { executionContextId: 'workspace-1', terminalId: terminal.terminalId, mode: 'shared' });

    await controller.request('terminal.input', {
      executionContextId: 'workspace-1',
      terminalId: terminal.terminalId,
      attachmentId: controlled.attachment.attachmentId,
      data: bytes('echo ready\r'),
    });
    await controller.request('terminal.resize', {
      executionContextId: 'workspace-1',
      terminalId: terminal.terminalId,
      attachmentId: controlled.attachment.attachmentId,
      cols: 120,
      rows: 40,
    });
    assertEquals(backend.inputs.at(-1), { terminalId: terminal.terminalId, data: bytes('echo ready\r') });
    assertEquals(backend.resizes.at(-1), { terminalId: terminal.terminalId, cols: 120, rows: 40 });

    await backend.emitOutput(terminal.terminalId, bytes('ready\r\n'));
    await tick();
    assertEquals(controlNotifications.at(-1)?.event, { type: 'output', data: bytes('ready\r\n') });
    assertEquals(observerNotifications.at(-1)?.event, { type: 'output', data: bytes('ready\r\n') });
    assertEquals(controlNotifications.at(-1)?.sequence, observerNotifications.at(-1)?.sequence);

    await assertRejects(
      () =>
        observer.request('terminal.input', {
          executionContextId: 'workspace-1',
          terminalId: terminal.terminalId,
          attachmentId: observed.attachment.attachmentId,
          data: bytes('forbidden'),
        }),
      PortalTerminalError,
      'writable attachment',
    );

    controller.close();
    const replacement = await competitor.request('terminal.attach', {
      executionContextId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'shared',
    });
    assertEquals(replacement.attachment.mode, 'shared');
    competitor.close();
  } finally {
    controller.close();
    observer.close();
    await service.close();
  }
});

test('TerminalAccess absorbs output captured during attach instead of replaying it twice', async () => {
  const backend = new CaptureAfterReleaseBackend();
  const service = new TerminalAccess({
    backend,
    resolveWorkspace: () => ({ executionContextId: 'workspace-1', path: '/workspace/one' }),
  });
  const notifications: TerminalNotification[] = [];
  const connection = service.openSession('connection-1', (event) => notifications.push(event));
  try {
    const terminal = (await connection.request('terminal.create', {
      executionContextId: 'workspace-1',
    })).terminal;
    const attaching = connection.request('terminal.attach', {
      executionContextId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'observe',
    });
    await tick();
    backend.emitOutput(terminal.terminalId, bytes('captured once\r\n'));
    backend.releaseCapture();
    const attached = await attaching;
    await tick();

    assertEquals(attached.snapshot.data, bytes('captured once\r\n'));
    assertEquals(
      notifications.filter(({ event }) => event.type === 'output'),
      [],
    );
  } finally {
    connection.close();
    await service.close();
  }
});

test('TerminalAccess still delivers captured attach output to existing attachments', async () => {
  const backend = new CaptureAfterReleaseBackend();
  const service = new TerminalAccess({
    backend,
    resolveWorkspace: () => ({ executionContextId: 'workspace-1', path: '/workspace/one' }),
  });
  const existingNotifications: TerminalNotification[] = [];
  const attachingNotifications: TerminalNotification[] = [];
  const existing = service.openSession('existing', (event) => existingNotifications.push(event));
  const attaching = service.openSession('attaching', (event) => attachingNotifications.push(event));
  try {
    const terminal = (await existing.request('terminal.create', {
      executionContextId: 'workspace-1',
    })).terminal;

    const firstAttach = existing.request('terminal.attach', {
      executionContextId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'observe',
    });
    await tick();
    backend.releaseCapture();
    await firstAttach;

    const secondAttach = attaching.request('terminal.attach', {
      executionContextId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'observe',
    });
    await tick();
    backend.emitOutput(terminal.terminalId, bytes('captured for second attach\r\n'));
    backend.releaseCapture();
    const attached = await secondAttach;
    await tick();

    assertEquals(attached.snapshot.data, bytes('captured for second attach\r\n'));
    assertEquals(
      existingNotifications.filter(({ event }) => event.type === 'output').map(({ event }) => event),
      [{ type: 'output', data: bytes('captured for second attach\r\n') }],
    );
    assertEquals(
      attachingNotifications.filter(({ event }) => event.type === 'output'),
      [],
    );
  } finally {
    existing.close();
    attaching.close();
    await service.close();
  }
});

test('TerminalAccess snapshots metadata changed during attach capture', async () => {
  const backend = new CaptureAfterReleaseBackend();
  const service = new TerminalAccess({
    backend,
    resolveWorkspace: () => ({ executionContextId: 'workspace-1', path: '/workspace/one' }),
  });
  const notifications: TerminalNotification[] = [];
  const connection = service.openSession('connection-1', (event) => notifications.push(event));
  try {
    const terminal = (await connection.request('terminal.create', {
      executionContextId: 'workspace-1',
    })).terminal;
    const attaching = connection.request('terminal.attach', {
      executionContextId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'observe',
    });
    await tick();
    backend.emitTitle(terminal.terminalId, 'changed during capture');
    backend.releaseCapture();
    const attached = await attaching;
    await tick();

    assertEquals(attached.snapshot.terminal.title, 'changed during capture');
    assertEquals(
      notifications.filter(({ event }) => event.type === 'title'),
      [],
    );
  } finally {
    connection.close();
    await service.close();
  }
});

test('TerminalAccess rejects an attach when the Terminal exits during capture', async () => {
  const backend = new CaptureAfterReleaseBackend();
  const service = new TerminalAccess({
    backend,
    resolveWorkspace: () => ({ executionContextId: 'workspace-1', path: '/workspace/one' }),
  });
  const connection = service.openSession('connection-1', () => undefined);
  try {
    const terminal = (await connection.request('terminal.create', {
      executionContextId: 'workspace-1',
    })).terminal;
    const attaching = connection.request('terminal.attach', {
      executionContextId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'observe',
    });
    await tick();
    backend.emitExit(terminal.terminalId, 0);
    backend.releaseCapture();

    await assertRejects(() => attaching, PortalTerminalError, 'unavailable');
  } finally {
    connection.close();
    await service.close();
  }
});

test('TerminalAccess preserves output emitted after the backend snapshot boundary', async () => {
  const backend = new FrozenCaptureBackend();
  const service = new TerminalAccess({
    backend,
    resolveWorkspace: () => ({ executionContextId: 'workspace-1', path: '/workspace/one' }),
  });
  const notifications: TerminalNotification[] = [];
  const connection = service.openSession('connection-1', (event) => notifications.push(event));
  try {
    const terminal = (await connection.request('terminal.create', {
      executionContextId: 'workspace-1',
    })).terminal;
    const attaching = connection.request('terminal.attach', {
      executionContextId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'observe',
    });
    await tick();
    backend.emitOutput(terminal.terminalId, bytes('live after snapshot\r\n'));
    backend.releaseCapture();
    const attached = await attaching;
    await tick();

    assertEquals(attached.snapshot.data, bytes(''));
    assertEquals(
      notifications.filter(({ event }) => event.type === 'output').map(({ event }) => event),
      [{ type: 'output', data: bytes('live after snapshot\r\n') }],
    );
  } finally {
    connection.close();
    await service.close();
  }
});

test('TerminalAccess detaches views without closing and requires the controller to close', async () => {
  const { backend, service } = createFixture();
  const controllerNotifications: TerminalNotification[] = [];
  const observerNotifications: TerminalNotification[] = [];
  const connection = service.openSession('connection-1', (event) => controllerNotifications.push(event));
  const observer = service.openSession('connection-2', (event) => observerNotifications.push(event));
  try {
    const terminal = (await connection.request('terminal.create', {
      executionContextId: 'workspace-1',
    })).terminal;
    const attached = await connection.request('terminal.attach', {
      executionContextId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'shared',
    });
    await connection.request('terminal.detach', {
      executionContextId: 'workspace-1',
      terminalId: terminal.terminalId,
      attachmentId: attached.attachment.attachmentId,
    });
    assertEquals(
      (await connection.request('terminal.list', {
        executionContextId: 'workspace-1',
      })).terminals.length,
      1,
    );
    assertEquals(backend.closed, []);

    const reattached = await connection.request('terminal.attach', {
      executionContextId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'shared',
    });
    await observer.request('terminal.attach', {
      executionContextId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'observe',
    });
    await connection.request('terminal.close', {
      executionContextId: 'workspace-1',
      terminalId: terminal.terminalId,
      attachmentId: reattached.attachment.attachmentId,
    });
    assertEquals(backend.closed, [terminal.terminalId]);
    assertEquals(
      controllerNotifications.filter(({ event }) => event.type === 'exit').length,
      1,
    );
    assertEquals(
      observerNotifications.filter(({ event }) => event.type === 'exit').length,
      1,
    );
    assertEquals(
      (await connection.request('terminal.list', {
        executionContextId: 'workspace-1',
      })).terminals,
      [],
    );
  } finally {
    connection.close();
    observer.close();
    await service.close();
  }
});

test('TerminalAccess reports a replay gap rather than returning partial retained output', async () => {
  const { backend, service } = createFixture({ retentionLimitBytes: 8 });
  const connection = service.openSession('connection-1', () => undefined);
  try {
    const terminal = (await connection.request('terminal.create', {
      executionContextId: 'workspace-1',
    })).terminal;
    const attached = await connection.request('terminal.attach', {
      executionContextId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'observe',
    });
    await backend.emitOutput(terminal.terminalId, bytes('123456'));
    await backend.emitOutput(terminal.terminalId, bytes('abcdef'));
    await tick();

    await assertRejects(
      () =>
        connection.request('terminal.attach', {
          executionContextId: 'workspace-1',
          terminalId: terminal.terminalId,
          mode: 'observe',
          cursor: attached.snapshot.cursor,
        }),
      PortalTerminalError,
      'retained output',
    );
  } finally {
    connection.close();
    await service.close();
  }
});

test('TerminalAccess releases control when the transport rejects its backlog', async () => {
  const { service } = createFixture();
  const stalled = service.openSession('stalled', () => false);
  const replacement = service.openSession('replacement', () => undefined);
  try {
    const terminal = (await stalled.request('terminal.create', {
      executionContextId: 'workspace-1',
    })).terminal;
    await stalled.request('terminal.attach', {
      executionContextId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'shared',
    });
    await tick();

    const attached = await replacement.request('terminal.attach', {
      executionContextId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'shared',
    });
    assertEquals(attached.attachment.mode, 'shared');
  } finally {
    stalled.close();
    replacement.close();
    await service.close();
  }
});

test('TerminalAccess delivers exit to healthy attachments when another sender throws', async () => {
  const { backend, service } = createFixture();
  const broken = service.openSession('broken', () => {
    throw new Error('transport failed');
  });
  const notifications: TerminalNotification[] = [];
  const healthy = service.openSession('healthy', (event) => notifications.push(event));
  try {
    const terminal = (await broken.request('terminal.create', {
      executionContextId: 'workspace-1',
    })).terminal;
    await broken.request('terminal.attach', {
      executionContextId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'shared',
    });
    await healthy.request('terminal.attach', {
      executionContextId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'observe',
    });

    backend.emitExit(terminal.terminalId, 0);
    await tick();
    assertEquals(notifications.filter(({ event }) => event.type === 'exit').length, 1);
  } finally {
    broken.close();
    healthy.close();
    await service.close();
  }
});

test('shared attachments accept both devices while size follows the last input device', async () => {
  const { backend, service } = createFixture();
  const mac = service.openSession('mac', () => undefined);
  const ipad = service.openSession('ipad', () => undefined);
  const legacy = service.openSession('legacy', () => undefined);
  try {
    const { terminal } = await mac.request('terminal.create', { executionContextId: 'workspace-1' });
    const target = { executionContextId: 'workspace-1', terminalId: terminal.terminalId };
    await legacy.request('terminal.attach', { ...target, mode: 'shared' });
    const a = { ...target, attachmentId: (await mac.request('terminal.attach', { ...target, mode: 'shared' })).attachment.attachmentId };
    const b = { ...target, attachmentId: (await ipad.request('terminal.attach', { ...target, mode: 'shared' })).attachment.attachmentId };
    await mac.request('terminal.resize', { ...a, cols: 120, rows: 40 });
    await ipad.request('terminal.resize', { ...b, cols: 80, rows: 24 });
    assertEquals(backend.resizes.map(({ cols, rows }) => [cols, rows]), []);
    await mac.request('terminal.input', { ...a, data: bytes('mac') });
    await ipad.request('terminal.input', { ...b, data: bytes('ipad') });
    await mac.request('terminal.resize', { ...a, cols: 130, rows: 42 });
    assertEquals(backend.resizes.map(({ cols, rows }) => [cols, rows]), [[120, 40], [80, 24]]);
    await mac.request('terminal.input', { ...a, data: bytes('back') });
    assertEquals(backend.inputs.map(({ data }) => new TextDecoder().decode(data)), ['mac', 'ipad', 'back']);
    assertEquals(backend.resizes.map(({ cols, rows }) => [cols, rows]), [[120, 40], [80, 24], [130, 42]]);
    await assertRejects(() => ipad.request('terminal.input', { ...a, data: bytes('wrong attachment') }), PortalTerminalError, 'unavailable');
    mac.close();
    await ipad.request('terminal.input', { ...b, data: bytes('still works') });
    assertEquals(backend.resizes.at(-1)?.cols, 80);
    assertEquals(backend.inputs.at(-1)?.data, bytes('still works'));
    await ipad.request('terminal.close', b);
    assertEquals(backend.closed, [terminal.terminalId]);
  } finally { mac.close(); ipad.close(); legacy.close(); await service.close(); }
});

test('a session disconnected while attachment lookup is pending cannot leave an orphan controller', async () => {
  const { backend, service } = createFixture();
  const stale = service.openSession('stale', () => undefined);
  const fresh = service.openSession('fresh', () => undefined);
  try {
    const { terminal } = await stale.request('terminal.create', { executionContextId: 'workspace-1' });
    const list = backend.list.bind(backend);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    backend.list = async () => { await gate; return list(); };
    const pending = stale.request('terminal.attach', { executionContextId: 'workspace-1', terminalId: terminal.terminalId, mode: 'shared' });
    stale.close();
    release();
    await assertRejects(() => pending, Error, 'closed');
    assertEquals(stale.attachmentIds(), []);
    const result = await fresh.request('terminal.attach', { executionContextId: 'workspace-1', terminalId: terminal.terminalId, mode: 'shared' });
    assertEquals(result.attachment.mode, 'shared');
  } finally { stale.close(); fresh.close(); await service.close(); }
});

test('new Weave shells receive themed visual-mode defaults without replacing explicit Host overrides', async () => {
  for (const override of [undefined, '#123456']) {
    const backend = new InMemoryTerminalExecution();
    const create = backend.create.bind(backend);
    let environment: Record<string, string> = {};
    backend.create = (input) => { environment = input.env; return create(input); };
    const service = new TerminalAccess({ backend, env: { ZVM_VI_HIGHLIGHT_BACKGROUND: override }, resolveWorkspace: () => ({ executionContextId: 'workspace-1', path: '/workspace/one' }) });
    const session = service.openSession('shell-theme', () => undefined);
    try {
      await session.request('terminal.create', { executionContextId: 'workspace-1' });
      assertEquals(environment.ZVM_VI_HIGHLIGHT_BACKGROUND, override ?? '#b4befe');
      assertEquals(environment.ZVM_VI_HIGHLIGHT_FOREGROUND, '#11111b');
    } finally { session.close(); await service.close(); }
  }
});


test('size changes replace all attachment screens before post-capture output', async () => {
  class ResizeBackend extends InMemoryTerminalExecution {
    resized = false;
    override async resize(id: string, cols: number, rows: number) {
      await super.resize(id, cols, rows);
      this.resized = true;
      this.emitOutput(id, bytes('redraw already captured'));
      this.setCapture(id, bytes('resized screen'));
    }
    override async capture(id: string) {
      const captured = await super.capture(id);
      if (this.resized) { this.resized = false; this.emitOutput(id, bytes('after capture')); }
      return captured;
    }
  }
  const backend = new ResizeBackend();
  const service = new TerminalAccess({ backend, resolveWorkspace: () => ({ executionContextId: 'workspace-1', path: '/tmp' }) });
  const received: TerminalNotification[][] = [[], []];
  const sessions = received.map((events, i) => service.openSession(`device-${i}`, (event) => { events.push(event); }));
  try {
    const { terminal } = await sessions[0]!.request('terminal.create', { executionContextId: 'workspace-1' });
    const target = { executionContextId: 'workspace-1', terminalId: terminal.terminalId };
    const attachments = await Promise.all(sessions.map((session) => session.request('terminal.attach', { ...target, mode: 'shared' })));
    await sessions[0]!.request('terminal.input', { ...target, attachmentId: attachments[0]!.attachment.attachmentId, data: bytes('claim size') });
    received.forEach((events) => { events.length = 0; });
    await sessions[0]!.request('terminal.resize', { ...target, attachmentId: attachments[0]!.attachment.attachmentId, cols: 150, rows: 50 });
    await tick();
    for (const events of received) {
      assertEquals(events.map(({ event }) => event.type), ['screen', 'output']);
      const screen = events[0]!.event;
      if (screen.type !== 'screen') throw new Error('Expected screen');
      assertEquals([screen.terminal.cols, screen.terminal.rows, new TextDecoder().decode(screen.data)], [150, 50, 'resized screen']);
      assertEquals(events[1]!.event, { type: 'output', data: bytes('after capture') });
    }
    await sessions[1]!.request('terminal.resize', { ...target, attachmentId: attachments[1]!.attachment.attachmentId, cols: 60, rows: 15 });
    assertEquals(backend.resizes.length, 1);
    received.forEach((events) => { events.length = 0; });
    await sessions[1]!.request('terminal.input', { ...target, attachmentId: attachments[1]!.attachment.attachmentId, data: bytes('take input') });
    await tick();
    for (const events of received) {
      const screen = events[0]!.event;
      if (screen.type !== 'screen') throw new Error('Expected replacement screen');
      assertEquals([screen.terminal.cols, screen.terminal.rows], [60, 15]);
    }
    assertEquals(backend.inputs.at(-1)?.data, bytes('take input'));
  } finally { sessions.forEach((session) => session.close()); await service.close(); }
});
