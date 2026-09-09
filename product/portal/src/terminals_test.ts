import { test } from './test-support.ts';
import { assertEquals, assertRejects } from './test-support.ts';
import type { TerminalNotification } from '@weave/product-protocol';
import { InMemoryTerminalBackend, PortalTerminalError, TerminalService } from './terminals.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class CaptureAfterReleaseBackend extends InMemoryTerminalBackend {
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

class FrozenCaptureBackend extends InMemoryTerminalBackend {
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
  const backend = new InMemoryTerminalBackend();
  const service = new TerminalService({
    backend,
    resolveWorkspace: (workspaceId) =>
      workspaceId === 'workspace-1' ? { workspaceId, path: '/workspace/one' } : undefined,
    ...options,
  });
  return { backend, service };
};

test('TerminalService creates, lists, snapshots, and reconnects persistent terminals', async () => {
  const { backend, service } = createFixture();
  const connection = service.openSession('connection-1', () => undefined);
  try {
    const created = await connection.request('terminal.create', {
      workspaceId: 'workspace-1',
      cols: 100,
      rows: 30,
    });
    assertEquals(created.terminal.workspaceId, 'workspace-1');
    assertEquals(created.terminal.status, 'running');
    assertEquals(created.terminal.cols, 100);
    assertEquals(
      (await connection.request('terminal.list', {
        workspaceId: 'workspace-1',
      })).terminals.map(({ terminalId }) => terminalId),
      [created.terminal.terminalId],
    );

    backend.setCapture(created.terminal.terminalId, '$ printf ready\r\nready\r\n');
    const first = await connection.request('terminal.snapshot', {
      workspaceId: 'workspace-1',
      terminalId: created.terminal.terminalId,
    });
    assertEquals(first.snapshot.data, '$ printf ready\r\nready\r\n');

    await service.close();
    const reopened = new TerminalService({
      backend,
      resolveWorkspace: () => ({ workspaceId: 'workspace-1', path: '/workspace/one' }),
    });
    const reconnect = reopened.openSession('connection-2', () => undefined);
    const afterRestart = await reconnect.request('terminal.snapshot', {
      workspaceId: 'workspace-1',
      terminalId: created.terminal.terminalId,
    });
    assertEquals(afterRestart.snapshot.data, '$ printf ready\r\nready\r\n');
    assertEquals(afterRestart.snapshot.generation === first.snapshot.generation, false);
    reconnect.close();
    await reopened.close();
  } finally {
    connection.close();
    await service.close();
  }
});

test('TerminalService allows one controller and many observers', async () => {
  const { backend, service } = createFixture();
  const controlNotifications: TerminalNotification[] = [];
  const observerNotifications: TerminalNotification[] = [];
  const controller = service.openSession('controller', (event) => controlNotifications.push(event));
  const observer = service.openSession('observer', (event) => observerNotifications.push(event));
  try {
    const terminal = (await controller.request('terminal.create', {
      workspaceId: 'workspace-1',
    })).terminal;
    const controlled = await controller.request('terminal.attach', {
      workspaceId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'control',
    });
    const observed = await observer.request('terminal.attach', {
      workspaceId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'observe',
    });
    assertEquals(controlled.attachment.mode, 'control');
    assertEquals(observed.attachment.mode, 'observe');

    const competitor = service.openSession('competitor', () => undefined);
    await assertRejects(
      () =>
        competitor.request('terminal.attach', {
          workspaceId: 'workspace-1',
          terminalId: terminal.terminalId,
          mode: 'control',
        }),
      PortalTerminalError,
      'controlled',
    );

    await controller.request('terminal.input', {
      workspaceId: 'workspace-1',
      terminalId: terminal.terminalId,
      attachmentId: controlled.attachment.attachmentId,
      data: 'echo ready\r',
    });
    await controller.request('terminal.resize', {
      workspaceId: 'workspace-1',
      terminalId: terminal.terminalId,
      attachmentId: controlled.attachment.attachmentId,
      cols: 120,
      rows: 40,
    });
    assertEquals(backend.inputs.at(-1), { terminalId: terminal.terminalId, data: 'echo ready\r' });
    assertEquals(backend.resizes.at(-1), { terminalId: terminal.terminalId, cols: 120, rows: 40 });

    await backend.emitOutput(terminal.terminalId, 'ready\r\n');
    await tick();
    assertEquals(controlNotifications.at(-1)?.event, { type: 'output', data: 'ready\r\n' });
    assertEquals(observerNotifications.at(-1)?.event, { type: 'output', data: 'ready\r\n' });
    assertEquals(controlNotifications.at(-1)?.sequence, observerNotifications.at(-1)?.sequence);

    await assertRejects(
      () =>
        observer.request('terminal.input', {
          workspaceId: 'workspace-1',
          terminalId: terminal.terminalId,
          attachmentId: observed.attachment.attachmentId,
          data: 'forbidden',
        }),
      PortalTerminalError,
      'control attachment',
    );

    controller.close();
    const replacement = await competitor.request('terminal.attach', {
      workspaceId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'control',
    });
    assertEquals(replacement.attachment.mode, 'control');
    competitor.close();
  } finally {
    controller.close();
    observer.close();
    await service.close();
  }
});

test('TerminalService absorbs output captured during attach instead of replaying it twice', async () => {
  const backend = new CaptureAfterReleaseBackend();
  const service = new TerminalService({
    backend,
    resolveWorkspace: () => ({ workspaceId: 'workspace-1', path: '/workspace/one' }),
  });
  const notifications: TerminalNotification[] = [];
  const connection = service.openSession('connection-1', (event) => notifications.push(event));
  try {
    const terminal = (await connection.request('terminal.create', {
      workspaceId: 'workspace-1',
    })).terminal;
    const attaching = connection.request('terminal.attach', {
      workspaceId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'observe',
    });
    await tick();
    backend.emitOutput(terminal.terminalId, 'captured once\r\n');
    backend.releaseCapture();
    const attached = await attaching;
    await tick();

    assertEquals(attached.snapshot.data, 'captured once\r\n');
    assertEquals(
      notifications.filter(({ event }) => event.type === 'output'),
      [],
    );
  } finally {
    connection.close();
    await service.close();
  }
});

test('TerminalService still delivers captured attach output to existing attachments', async () => {
  const backend = new CaptureAfterReleaseBackend();
  const service = new TerminalService({
    backend,
    resolveWorkspace: () => ({ workspaceId: 'workspace-1', path: '/workspace/one' }),
  });
  const existingNotifications: TerminalNotification[] = [];
  const attachingNotifications: TerminalNotification[] = [];
  const existing = service.openSession('existing', (event) => existingNotifications.push(event));
  const attaching = service.openSession('attaching', (event) => attachingNotifications.push(event));
  try {
    const terminal = (await existing.request('terminal.create', {
      workspaceId: 'workspace-1',
    })).terminal;

    const firstAttach = existing.request('terminal.attach', {
      workspaceId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'observe',
    });
    await tick();
    backend.releaseCapture();
    await firstAttach;

    const secondAttach = attaching.request('terminal.attach', {
      workspaceId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'observe',
    });
    await tick();
    backend.emitOutput(terminal.terminalId, 'captured for second attach\r\n');
    backend.releaseCapture();
    const attached = await secondAttach;
    await tick();

    assertEquals(attached.snapshot.data, 'captured for second attach\r\n');
    assertEquals(
      existingNotifications.filter(({ event }) => event.type === 'output').map(({ event }) => event),
      [{ type: 'output', data: 'captured for second attach\r\n' }],
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

test('TerminalService snapshots metadata changed during attach capture', async () => {
  const backend = new CaptureAfterReleaseBackend();
  const service = new TerminalService({
    backend,
    resolveWorkspace: () => ({ workspaceId: 'workspace-1', path: '/workspace/one' }),
  });
  const notifications: TerminalNotification[] = [];
  const connection = service.openSession('connection-1', (event) => notifications.push(event));
  try {
    const terminal = (await connection.request('terminal.create', {
      workspaceId: 'workspace-1',
    })).terminal;
    const attaching = connection.request('terminal.attach', {
      workspaceId: 'workspace-1',
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

test('TerminalService rejects an attach when the Terminal exits during capture', async () => {
  const backend = new CaptureAfterReleaseBackend();
  const service = new TerminalService({
    backend,
    resolveWorkspace: () => ({ workspaceId: 'workspace-1', path: '/workspace/one' }),
  });
  const connection = service.openSession('connection-1', () => undefined);
  try {
    const terminal = (await connection.request('terminal.create', {
      workspaceId: 'workspace-1',
    })).terminal;
    const attaching = connection.request('terminal.attach', {
      workspaceId: 'workspace-1',
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

test('TerminalService preserves output emitted after the backend snapshot boundary', async () => {
  const backend = new FrozenCaptureBackend();
  const service = new TerminalService({
    backend,
    resolveWorkspace: () => ({ workspaceId: 'workspace-1', path: '/workspace/one' }),
  });
  const notifications: TerminalNotification[] = [];
  const connection = service.openSession('connection-1', (event) => notifications.push(event));
  try {
    const terminal = (await connection.request('terminal.create', {
      workspaceId: 'workspace-1',
    })).terminal;
    const attaching = connection.request('terminal.attach', {
      workspaceId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'observe',
    });
    await tick();
    backend.emitOutput(terminal.terminalId, 'live after snapshot\r\n');
    backend.releaseCapture();
    const attached = await attaching;
    await tick();

    assertEquals(attached.snapshot.data, '');
    assertEquals(
      notifications.filter(({ event }) => event.type === 'output').map(({ event }) => event),
      [{ type: 'output', data: 'live after snapshot\r\n' }],
    );
  } finally {
    connection.close();
    await service.close();
  }
});

test('TerminalService detaches views without closing and requires the controller to close', async () => {
  const { backend, service } = createFixture();
  const controllerNotifications: TerminalNotification[] = [];
  const observerNotifications: TerminalNotification[] = [];
  const connection = service.openSession('connection-1', (event) => controllerNotifications.push(event));
  const observer = service.openSession('connection-2', (event) => observerNotifications.push(event));
  try {
    const terminal = (await connection.request('terminal.create', {
      workspaceId: 'workspace-1',
    })).terminal;
    const attached = await connection.request('terminal.attach', {
      workspaceId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'control',
    });
    await connection.request('terminal.detach', {
      workspaceId: 'workspace-1',
      terminalId: terminal.terminalId,
      attachmentId: attached.attachment.attachmentId,
    });
    assertEquals(
      (await connection.request('terminal.list', {
        workspaceId: 'workspace-1',
      })).terminals.length,
      1,
    );
    assertEquals(backend.closed, []);

    const reattached = await connection.request('terminal.attach', {
      workspaceId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'control',
    });
    await observer.request('terminal.attach', {
      workspaceId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'observe',
    });
    await connection.request('terminal.close', {
      workspaceId: 'workspace-1',
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
        workspaceId: 'workspace-1',
      })).terminals,
      [],
    );
  } finally {
    connection.close();
    observer.close();
    await service.close();
  }
});

test('TerminalService reports a replay gap rather than returning partial retained output', async () => {
  const { backend, service } = createFixture({ retentionLimitBytes: 8 });
  const connection = service.openSession('connection-1', () => undefined);
  try {
    const terminal = (await connection.request('terminal.create', {
      workspaceId: 'workspace-1',
    })).terminal;
    const attached = await connection.request('terminal.attach', {
      workspaceId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'observe',
    });
    await backend.emitOutput(terminal.terminalId, '123456');
    await backend.emitOutput(terminal.terminalId, 'abcdef');
    await tick();

    await assertRejects(
      () =>
        connection.request('terminal.attach', {
          workspaceId: 'workspace-1',
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

test('TerminalService releases control when the transport rejects its backlog', async () => {
  const { service } = createFixture();
  const stalled = service.openSession('stalled', () => false);
  const replacement = service.openSession('replacement', () => undefined);
  try {
    const terminal = (await stalled.request('terminal.create', {
      workspaceId: 'workspace-1',
    })).terminal;
    await stalled.request('terminal.attach', {
      workspaceId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'control',
    });
    await tick();

    const attached = await replacement.request('terminal.attach', {
      workspaceId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'control',
    });
    assertEquals(attached.attachment.mode, 'control');
  } finally {
    stalled.close();
    replacement.close();
    await service.close();
  }
});

test('TerminalService delivers exit to healthy attachments when another sender throws', async () => {
  const { backend, service } = createFixture();
  const broken = service.openSession('broken', () => {
    throw new Error('transport failed');
  });
  const notifications: TerminalNotification[] = [];
  const healthy = service.openSession('healthy', (event) => notifications.push(event));
  try {
    const terminal = (await broken.request('terminal.create', {
      workspaceId: 'workspace-1',
    })).terminal;
    await broken.request('terminal.attach', {
      workspaceId: 'workspace-1',
      terminalId: terminal.terminalId,
      mode: 'control',
    });
    await healthy.request('terminal.attach', {
      workspaceId: 'workspace-1',
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
