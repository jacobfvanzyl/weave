import { assertEquals, assertExists } from 'jsr:@std/assert@1.0.19';
import {
  decodeTmuxControlOutputBytes,
  decodeTmuxControlOutputValue,
  encodeTerminalInputHex,
  parseTmuxControlNotification,
  PortalTerminalHost,
  type PortalTmuxControlClient,
  type PortalTmuxControlClientHandlers,
  type PortalTmuxController,
  type PortalTmuxWindowRecord,
  resolveTmuxDefaultTerminal,
  type TerminalHostEvent,
  type TerminalWindowRecord,
  TmuxControlOutputDecoder,
  TmuxTerminalController,
} from './terminal.ts';

type FakeTmuxWindow = PortalTmuxWindowRecord & {
  scopeId: string;
  capture?: string;
};

class FakeControlClient implements PortalTmuxControlClient {
  closed = false;
  inputs: Array<{ paneId: string; data: string }> = [];
  resizes: Array<{ windowId: string; cols: number; rows: number }> = [];
  continues: string[] = [];

  constructor(
    private readonly handlers: PortalTmuxControlClientHandlers,
    private readonly onResize?: (resize: { windowId: string; cols: number; rows: number }) => void,
  ) {}

  async start() {}

  async input(paneId: string, data: string) {
    this.inputs.push({ paneId, data });
  }

  async resize(windowId: string, cols: number, rows: number) {
    const resize = { windowId, cols, rows };
    this.resizes.push(resize);
    this.onResize?.(resize);
  }

  async continueOutput(paneId: string) {
    this.continues.push(paneId);
  }

  close() {
    this.closed = true;
  }

  emitOutput(paneId: string, data: string) {
    this.handlers.onOutput(paneId, data);
  }

  emitPause(paneId: string) {
    this.handlers.onPause(paneId);
  }

  emitContinue(paneId: string) {
    this.handlers.onContinue(paneId);
  }

  emitWindowClose(windowId: string) {
    this.handlers.onWindowClose(windowId);
  }
}

class FakeTmux implements PortalTmuxController {
  windows: FakeTmuxWindow[] = [];
  killedWindows: string[] = [];
  createdEnvs: Record<string, string>[] = [];
  controlClients: FakeControlClient[] = [];
  captures: Array<{ terminalId: string; resizes: FakeControlClient['resizes'] }> = [];
  onResize?: (resize: { windowId: string; cols: number; rows: number }) => void;
  private nextWindowSerial = 0;

  async listAllWindows() {
    return this.windows
      .sort((left, right) =>
        left.scopeId.localeCompare(right.scopeId) ||
        left.slot - right.slot ||
        left.terminalId.localeCompare(right.terminalId)
      )
      .map(this.toRecord);
  }

  async listWindows(target: Parameters<PortalTmuxController['listWindows']>[0]) {
    const scopeIds = new Set(target.scopeIds?.length ? target.scopeIds : [target.scopeId]);
    return this.windows
      .filter((window) => scopeIds.has(window.scopeId))
      .sort((left, right) => left.slot - right.slot || left.terminalId.localeCompare(right.terminalId))
      .map(this.toRecord);
  }

  async createWindow(
    target: Parameters<PortalTmuxController['createWindow']>[0],
    input: Parameters<PortalTmuxController['createWindow']>[1],
  ) {
    const existing = await this.listWindows(target);
    const occupied = new Set(existing.map((window) => window.slot));
    const slot = input.slot ?? (() => {
      let next = 1;
      while (occupied.has(next)) next += 1;
      return next;
    })();
    const terminalId = `weave:terminal:v1:${target.scopeId}:slot:${slot}`;
    const duplicate = this.windows.find((window) => window.terminalId === terminalId);
    if (duplicate) return duplicate;
    this.createdEnvs.push({ ...input.env, WEAVE_TERMINAL_ID: terminalId });
    const serial = this.nextWindowSerial;
    this.nextWindowSerial += 1;
    const window = {
      terminalId,
      slot,
      kind: target.kind,
      cwd: target.cwd,
      title: `Terminal ${slot}`,
      windowIndex: String(slot),
      windowId: `@${serial}`,
      paneId: `%${serial}`,
      target: `@${serial}`,
      portalId: target.portalId,
      rootId: target.rootId,
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      scopeId: target.scopeId,
    };
    this.windows.push(window);
    return window;
  }

  async ensureWindow(
    target: Parameters<PortalTmuxController['ensureWindow']>[0],
    input: Parameters<PortalTmuxController['ensureWindow']>[1],
  ) {
    const existing = this.windows.find((window) => window.terminalId === input.terminalId);
    if (existing) return existing;
    const slot = Number(input.terminalId.split(':slot:').at(-1));
    return await this.createWindow(target, {
      env: input.env,
      shell: input.shell,
      slot: Number.isInteger(slot) && slot > 0 ? slot : 1,
    });
  }

  async findWindow(terminalId: string) {
    return this.windows.find((window) => window.terminalId === terminalId);
  }

  async openControlClient(handlers: PortalTmuxControlClientHandlers) {
    const client = new FakeControlClient(handlers, (resize) => this.onResize?.(resize));
    this.controlClients.push(client);
    await client.start();
    return client;
  }

  async killWindow(terminalId: string) {
    this.killedWindows.push(terminalId);
    this.windows = this.windows.filter((window) => window.terminalId !== terminalId);
  }

  async captureWindow(terminalId: string) {
    this.captures.push({
      terminalId,
      resizes: this.controlClients.at(-1)?.resizes.map((resize) => ({ ...resize })) ?? [],
    });
    return this.windows.find((window) => window.terminalId === terminalId)?.capture ?? '';
  }

  private toRecord = (window: FakeTmuxWindow): TerminalWindowRecord => ({
    terminalId: window.terminalId,
    scopeId: window.scopeId,
    slot: window.slot,
    kind: window.kind,
    cwd: window.cwd,
    title: window.title,
    ...(window.processName ? { processName: window.processName } : {}),
    ...(window.portalId ? { portalId: window.portalId } : {}),
    ...(window.rootId ? { rootId: window.rootId } : {}),
    ...(window.projectId ? { projectId: window.projectId } : {}),
    ...(window.workspaceId ? { workspaceId: window.workspaceId } : {}),
  });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const testBase64UrlEncode = (value: string) => btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const withHost = async (
  callback: (context: {
    cwd: string;
    host: PortalTerminalHost;
    tmux: FakeTmux;
  }) => Promise<void>,
  tmux = new FakeTmux(),
  hostOptions: {
    outputBatchMs?: number;
    replayCaptureSettleMs?: number;
    replayLimitBytes?: number;
  } = {},
) => {
  const cwd = await Deno.makeTempDir({ prefix: 'weave-terminal-' });
  const realCwd = await Deno.realPath(cwd);
  const host = new PortalTerminalHost({
    config: {},
    tmux,
    outputBatchMs: 1,
    replayLimitBytes: 1024,
    replayCaptureSettleMs: 0,
    env: { SHELL: '/bin/test-shell', WEAVE_PORTAL_TMUX_TERM: 'tmux-256color' },
    ...hostOptions,
  });

  try {
    await callback({ cwd: realCwd, host, tmux });
  } finally {
    host.dispose();
    await Deno.remove(cwd, { recursive: true });
  }
};

Deno.test('PortalTerminalHost creates deterministic tmux windows and restores them after host restart', async () => {
  const cwd = await Deno.makeTempDir({ prefix: 'weave-terminal-' });
  const realCwd = await Deno.realPath(cwd);
  const tmux = new FakeTmux();
  const createHost = () =>
    new PortalTerminalHost({
      config: {},
      tmux,
      outputBatchMs: 1,
      replayLimitBytes: 1024,
      replayCaptureSettleMs: 0,
      env: { SHELL: '/bin/test-shell', WEAVE_PORTAL_TMUX_TERM: 'tmux-256color' },
    });

  try {
    const firstHost = createHost();
    const createEvents: TerminalHostEvent[] = [];
    await firstHost.handleClientMessage('client-1', {
      type: 'create',
      kind: 'workspace',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      workspacePath: realCwd,
      cols: 100,
      rows: 30,
    }, (event) => createEvents.push(event));

    assertEquals(createEvents[0]?.type, 'created');
    const created = createEvents[0]?.type === 'created' ? createEvents[0].window : undefined;
    assertExists(created);
    assertEquals(created.slot, 1);
    assertEquals(created.workspaceId, 'workspace-1');
    assertEquals(created.terminalId.includes(':slot:1'), true);

    const startEvents: TerminalHostEvent[] = [];
    await firstHost.handleClientMessage('client-1', {
      type: 'start',
      kind: 'workspace',
      terminalId: created.terminalId,
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      workspacePath: realCwd,
      cols: 100,
      rows: 30,
    }, (event) => startEvents.push(event));
    assertEquals(startEvents[0], {
      type: 'started',
      terminalId: created.terminalId,
      workspaceId: 'workspace-1',
      sessionId: created.terminalId,
      cwd: realCwd,
      pid: undefined,
      cols: 100,
      rows: 30,
    });
    assertEquals(tmux.controlClients.length, 1);
    firstHost.dispose();

    const secondHost = createHost();
    const listEvents: TerminalHostEvent[] = [];
    await secondHost.handleClientMessage('client-2', {
      type: 'list',
      kind: 'workspace',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      workspacePath: realCwd,
    }, (event) => listEvents.push(event));
    assertEquals(listEvents[0], {
      type: 'windows',
      requestId: undefined,
      windows: [created],
    });
    secondHost.dispose();
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test('PortalTerminalHost restores legacy general windows when portal identity becomes available', async () => {
  const cwd = await Deno.makeTempDir({ prefix: 'weave-terminal-' });
  const realCwd = await Deno.realPath(cwd);
  const tmux = new FakeTmux();
  const legacyScope = { kind: 'general' as const, rootId: 'default', cwd: realCwd };
  const legacyScopeId = testBase64UrlEncode(JSON.stringify(legacyScope));
  const legacyWindow: TerminalWindowRecord = {
    terminalId: `weave:terminal:v1:${legacyScopeId}:slot:1`,
    scopeId: legacyScopeId,
    slot: 1,
    kind: 'general',
    cwd: realCwd,
    title: 'Terminal 1',
  };
  tmux.windows.push({
    ...legacyWindow,
    scopeId: legacyScopeId,
    windowIndex: '1',
    windowId: '@legacy',
    paneId: '%legacy',
    target: '@legacy',
  });
  const host = new PortalTerminalHost({
    config: {
      portalId: 'portal-1',
      roots: [{ id: 'default', path: realCwd }],
    },
    tmux,
    replayCaptureSettleMs: 0,
    env: { SHELL: '/bin/test-shell', WEAVE_PORTAL_TMUX_TERM: 'tmux-256color' },
  });

  try {
    const listEvents: TerminalHostEvent[] = [];
    await host.handleClientMessage('client-1', {
      type: 'list',
      kind: 'general',
      portalId: 'portal-1',
      rootId: 'default',
    }, (event) => listEvents.push(event));

    assertEquals(listEvents[0], {
      type: 'windows',
      requestId: undefined,
      windows: [legacyWindow],
    });

    const createEvents: TerminalHostEvent[] = [];
    await host.handleClientMessage('client-1', {
      type: 'create',
      kind: 'general',
      rootId: 'default',
    }, (event) => createEvents.push(event));
    const created = createEvents[0]?.type === 'created' ? createEvents[0].window : undefined;
    assertExists(created);
    assertEquals(created.slot, 2);
    assertEquals(created.terminalId === legacyWindow.terminalId, false);
  } finally {
    host.dispose();
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test('PortalTerminalHost snapshot lists all tmux windows sorted by scope and slot', async () => {
  const cwd = await Deno.makeTempDir({ prefix: 'weave-terminal-' });
  const realCwd = await Deno.realPath(cwd);
  const tmux = new FakeTmux();
  const host = new PortalTerminalHost({
    config: {},
    tmux,
    replayCaptureSettleMs: 0,
    env: { SHELL: '/bin/test-shell', WEAVE_PORTAL_TMUX_TERM: 'tmux-256color' },
  });

  try {
    const createEvents: TerminalHostEvent[] = [];
    await host.handleClientMessage('client-1', {
      type: 'create',
      kind: 'general',
      cwd: realCwd,
    }, (event) => createEvents.push(event));
    await host.handleClientMessage('client-1', {
      type: 'create',
      kind: 'workspace',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      workspacePath: realCwd,
    }, (event) => createEvents.push(event));

    const createdWindows = createEvents
      .filter((event): event is Extract<TerminalHostEvent, { type: 'created' }> => event.type === 'created')
      .map((event) => event.window)
      .sort((left, right) => left.scopeId.localeCompare(right.scopeId) || left.slot - right.slot);
    const snapshotEvents: TerminalHostEvent[] = [];
    await host.handleClientMessage('client-2', { type: 'snapshot' }, (event) => snapshotEvents.push(event));

    assertEquals(snapshotEvents[0], {
      type: 'windows',
      requestId: undefined,
      windows: createdWindows,
    });
  } finally {
    host.dispose();
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test('PortalTerminalHost exposes project/workspace environment for workspace sessions', async () =>
  withHost(async ({ cwd, host, tmux }) => {
    await host.handleClientMessage('client-1', {
      type: 'create',
      kind: 'workspace',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      workspacePath: cwd,
    }, () => undefined);

    assertEquals(tmux.createdEnvs[0].WEAVE_TERMINAL_KIND, 'workspace');
    assertEquals(tmux.createdEnvs[0].WEAVE_PROJECT_ID, 'project-1');
    assertEquals(tmux.createdEnvs[0].WEAVE_WORKSPACE_ID, 'workspace-1');
    assertEquals(tmux.createdEnvs[0].WEAVE_TERMINAL_ID.includes(':slot:1'), true);
    assertEquals(tmux.createdEnvs[0].PROMPT_EOL_MARK, '');
    assertEquals('WEAVE_PLANE_ID' in tmux.createdEnvs[0], false);
    assertEquals('WEAVE_DEMIPLANE_ID' in tmux.createdEnvs[0], false);
  }));

Deno.test('PortalTerminalHost routes input, resize, detach, close, and exit', async () =>
  withHost(async ({ cwd, host, tmux }) => {
    const events: TerminalHostEvent[] = [];
    await host.handleClientMessage('client-1', {
      type: 'create',
      kind: 'general',
      cwd,
    }, (event) => events.push(event));
    const created = events[0]?.type === 'created' ? events[0].window : undefined;
    assertExists(created);

    await host.handleClientMessage('client-1', {
      type: 'start',
      kind: 'general',
      terminalId: created.terminalId,
      cwd,
      cols: 90,
      rows: 24,
    }, (event) => events.push(event));

    const firstControlClient = tmux.controlClients[0];
    assertExists(firstControlClient);
    await host.handleClientMessage(
      'client-1',
      { type: 'input', terminalId: created.terminalId, data: 'pwd\r' },
      (event) => events.push(event),
    );
    await host.handleClientMessage(
      'client-1',
      { type: 'resize', terminalId: created.terminalId, cols: 132, rows: 40 },
      (event) => events.push(event),
    );
    assertEquals(firstControlClient.inputs, [{ paneId: tmux.windows[0].paneId, data: 'pwd\r' }]);
    assertEquals(firstControlClient.resizes, [
      { windowId: tmux.windows[0].windowId, cols: 90, rows: 24 },
      { windowId: tmux.windows[0].windowId, cols: 132, rows: 40 },
    ]);

    await host.handleClientMessage(
      'client-1',
      { type: 'detach', terminalId: created.terminalId },
      (event) => events.push(event),
    );
    assertEquals(tmux.windows.length, 1);
    assertEquals(firstControlClient.closed, false);
    firstControlClient.emitOutput(tmux.windows[0].paneId, 'after detach');
    await delay(5);
    assertEquals(events.some((event) => event.type === 'output' && event.data === 'after detach'), false);
    tmux.windows[0].capture = 'recaptured-after-detach';

    const reattachEvents: TerminalHostEvent[] = [];
    await host.handleClientMessage(
      'client-2',
      { type: 'start', kind: 'general', terminalId: created.terminalId, cwd },
      (event) => {
        reattachEvents.push(event);
        events.push(event);
      },
    );
    assertEquals(tmux.controlClients.length, 1);
    assertEquals(tmux.windows.length, 1);
    assertEquals(reattachEvents.find((event) => event.type === 'replay'), {
      type: 'replay',
      terminalId: created.terminalId,
      workspaceId: undefined,
      data: 'recaptured-after-detach',
    });
    await host.handleClientMessage(
      'client-2',
      { type: 'close', terminalId: created.terminalId },
      (event) => events.push(event),
    );
    assertEquals(tmux.windows.length, 0);
    assertEquals(firstControlClient.closed, true);
    assertEquals(events.at(-1), {
      type: 'exit',
      terminalId: created.terminalId,
      workspaceId: undefined,
      exitCode: undefined,
      signal: undefined,
    });
  }));

Deno.test('PortalTerminalHost flushes queued output before continuing a paused tmux pane', async () =>
  withHost(async ({ cwd, host, tmux }) => {
    const events: TerminalHostEvent[] = [];
    await host.handleClientMessage('client-1', {
      type: 'create',
      kind: 'general',
      cwd,
    }, (event) => events.push(event));
    const created = events[0]?.type === 'created' ? events[0].window : undefined;
    assertExists(created);

    await host.handleClientMessage('client-1', {
      type: 'start',
      kind: 'general',
      terminalId: created.terminalId,
      cwd,
    }, (event) => events.push(event));

    const controlClient = tmux.controlClients[0];
    assertExists(controlClient);
    const paneId = tmux.windows[0].paneId;
    controlClient.emitOutput(paneId, 'queued-heavy-output');
    assertEquals(events.some((event) => event.type === 'output' && event.data === 'queued-heavy-output'), false);

    controlClient.emitPause(paneId);

    assertEquals(events.some((event) => event.type === 'output' && event.data === 'queued-heavy-output'), true);
    assertEquals(controlClient.continues, [paneId]);
  }, new FakeTmux(), { outputBatchMs: 1_000 }));

Deno.test('PortalTerminalHost normalizes captured replay newlines for terminal rendering', async () =>
  withHost(async ({ cwd, host, tmux }) => {
    const events: TerminalHostEvent[] = [];
    await host.handleClientMessage('client-1', {
      type: 'create',
      kind: 'general',
      cwd,
    }, (event) => events.push(event));
    const created = events.find((event) => event.type === 'created')?.window;
    assertExists(created);
    const window = tmux.windows.find((item) => item.terminalId === created.terminalId);
    assertExists(window);
    window.capture = 'first line\nsecond line\r\nthird line';

    const startEvents: TerminalHostEvent[] = [];
    await host.handleClientMessage('client-1', {
      type: 'start',
      kind: 'general',
      terminalId: created.terminalId,
      cwd,
    }, (event) => startEvents.push(event));

    const replay = startEvents.find((event) => event.type === 'replay');
    assertEquals(replay, {
      type: 'replay',
      terminalId: created.terminalId,
      workspaceId: undefined,
      data: 'first line\r\nsecond line\r\nthird line',
    });
  }));

Deno.test('PortalTerminalHost resizes the control client before capturing replay', async () =>
  withHost(async ({ cwd, host, tmux }) => {
    const events: TerminalHostEvent[] = [];
    await host.handleClientMessage('client-1', {
      type: 'create',
      kind: 'general',
      cwd,
    }, (event) => events.push(event));
    const created = events.find((event) => event.type === 'created')?.window;
    assertExists(created);
    const window = tmux.windows.find((item) => item.terminalId === created.terminalId);
    assertExists(window);
    window.capture = 'prompt';

    await host.handleClientMessage('client-1', {
      type: 'start',
      kind: 'general',
      terminalId: created.terminalId,
      cwd,
      cols: 132,
      rows: 40,
    }, () => undefined);

    assertEquals(tmux.captures, [{
      terminalId: created.terminalId,
      resizes: [{ windowId: window.windowId, cols: 132, rows: 40 }],
    }]);
  }));

Deno.test('PortalTerminalHost waits for resized pane redraw before capturing replay', async () => {
  const tmux = new FakeTmux();
  await withHost(async ({ cwd, host, tmux }) => {
    const events: TerminalHostEvent[] = [];
    await host.handleClientMessage('client-1', {
      type: 'create',
      kind: 'general',
      cwd,
    }, (event) => events.push(event));
    const created = events.find((event) => event.type === 'created')?.window;
    assertExists(created);
    const window = tmux.windows.find((item) => item.terminalId === created.terminalId);
    assertExists(window);
    window.capture = 'small-screen';
    tmux.onResize = () => {
      setTimeout(() => {
        window.capture = 'large-screen';
      }, 5);
    };

    await host.handleClientMessage('client-1', {
      type: 'start',
      kind: 'general',
      terminalId: created.terminalId,
      cwd,
      cols: 132,
      rows: 40,
    }, (event) => events.push(event));

    const replay = events.find((event) => event.type === 'replay');
    assertEquals(replay?.type === 'replay' ? replay.data : undefined, 'large-screen');

    const controlClient = tmux.controlClients[0];
    assertExists(controlClient);
    controlClient.emitOutput(window.paneId, 'redraw-after-replay');
    await delay(5);
    assertEquals(events.some((event) => event.type === 'output' && event.data === 'redraw-after-replay'), true);
  }, tmux, { replayCaptureSettleMs: 20 });
});

Deno.test('PortalTerminalHost recaptures active sessions after resizing instead of using buffered output', async () =>
  withHost(async ({ cwd, host, tmux }) => {
    const events: TerminalHostEvent[] = [];
    await host.handleClientMessage('client-1', {
      type: 'create',
      kind: 'general',
      cwd,
    }, (event) => events.push(event));
    const created = events.find((event) => event.type === 'created')?.window;
    assertExists(created);
    const window = tmux.windows.find((item) => item.terminalId === created.terminalId);
    assertExists(window);
    window.capture = 'first-capture';

    await host.handleClientMessage('client-1', {
      type: 'start',
      kind: 'general',
      terminalId: created.terminalId,
      cwd,
    }, (event) => events.push(event));

    const controlClient = tmux.controlClients[0];
    assertExists(controlClient);
    controlClient.emitOutput(window.paneId, '-live-output');
    await delay(5);

    window.capture = 'second-capture';
    const reattachEvents: TerminalHostEvent[] = [];
    await host.handleClientMessage('client-2', {
      type: 'start',
      kind: 'general',
      terminalId: created.terminalId,
      cwd,
      cols: 132,
      rows: 40,
    }, (event) => reattachEvents.push(event));

    const replay = reattachEvents.find((event) => event.type === 'replay');
    assertEquals(replay?.type === 'replay' ? replay.data : undefined, 'second-capture');
    assertEquals(tmux.captures.map((capture) => capture.terminalId), [
      created.terminalId,
      created.terminalId,
    ]);
    assertEquals(tmux.captures.at(-1)?.resizes.at(-1), {
      windowId: window.windowId,
      cols: 132,
      rows: 40,
    });
  }));

Deno.test('PortalTerminalHost keeps idle tmux windows after all UI sessions detach', async () =>
  withHost(async ({ cwd, host, tmux }) => {
    const createdWindows: TerminalWindowRecord[] = [];
    for (let index = 0; index < 3; index += 1) {
      const events: TerminalHostEvent[] = [];
      await host.handleClientMessage('client-1', {
        type: 'create',
        kind: 'general',
        cwd,
      }, (event) => events.push(event));
      const created = events.find((event) => event.type === 'created')?.window;
      assertExists(created);
      createdWindows.push(created);

      await host.handleClientMessage('client-1', {
        type: 'start',
        kind: 'general',
        terminalId: created.terminalId,
        cwd,
      }, () => undefined);
      await host.handleClientMessage('client-1', {
        type: 'detach',
        terminalId: created.terminalId,
      }, () => undefined);
    }

    assertEquals(tmux.windows.length, 3);
    assertEquals(tmux.controlClients.length, 1);
    assertEquals(tmux.controlClients[0].closed, false);
    assertEquals(tmux.captures.map((capture) => capture.terminalId), createdWindows.map((window) => window.terminalId));

    const listEvents: TerminalHostEvent[] = [];
    await host.handleClientMessage(
      'client-2',
      { type: 'list', kind: 'general', cwd },
      (event) => listEvents.push(event),
    );
    assertEquals(listEvents[0], {
      type: 'windows',
      requestId: undefined,
      windows: createdWindows,
    });

    for (const created of createdWindows) {
      const reopenEvents: TerminalHostEvent[] = [];
      await host.handleClientMessage('client-2', {
        type: 'start',
        kind: 'general',
        terminalId: created.terminalId,
        cwd,
      }, (event) => reopenEvents.push(event));
      assertEquals(reopenEvents.some((event) => event.type === 'started' && event.terminalId === created.terminalId), true);
    }
    assertEquals(tmux.captures.map((capture) => capture.terminalId), [
      ...createdWindows.map((window) => window.terminalId),
      ...createdWindows.map((window) => window.terminalId),
    ]);
  }));

Deno.test('TmuxTerminalController uses deterministic socket path and _weave session', async () => {
  const portalHome = await Deno.makeTempDir({ prefix: 'weave-tmux-home-' });
  const cwd = await Deno.makeTempDir({ prefix: 'weave-tmux-cwd-' });
  const calls: string[][] = [];
  const envs: Array<Record<string, string>> = [];
  const runner = async (args: string[], options?: { env?: Record<string, string> }) => {
    calls.push(args);
    envs.push(options?.env ?? {});
    const command = args[4];
    if (command === 'has-session') return { ok: false, stdout: '', stderr: '', code: 1 };
    if (command === 'list-windows') return { ok: true, stdout: '', stderr: '', code: 0 };
    return { ok: true, stdout: '', stderr: '', code: 0 };
  };
  const controller = new TmuxTerminalController({
    portalHome,
    runner,
    env: { PATH: '/usr/bin:/bin', NO_COLOR: '1', WEAVE_PORTAL_TMUX_TERM: 'tmux-256color' },
  });

  try {
    await controller.listWindows(
      {
        kind: 'general',
        cwd,
        cols: 80,
        rows: 24,
        scope: { kind: 'general', cwd },
        scopeId: 'scope',
      } as Parameters<PortalTmuxController['listWindows']>[0],
    );

    assertEquals(
      calls.every((args) =>
        args[0] === '-f' && args[1] === `${portalHome}/tmux/tmux.conf` &&
        args[2] === '-S' && args[3] === `${portalHome}/tmux/_weave.sock`
      ),
      true,
    );
    const config = await Deno.readTextFile(`${portalHome}/tmux/tmux.conf`);
    assertEquals(config.includes('set-option -g status off'), true);
    assertEquals(config.includes('set-option -g prefix None'), true);
    assertEquals(config.includes('set-option -g detach-on-destroy on'), true);
    assertEquals(config.includes('set-option -g base-index 0'), true);
    assertEquals(config.includes('unbind-key -aT root'), true);
    assertEquals(config.includes('unbind-key -aT prefix'), true);
    assertEquals(config.includes('set-option -g default-terminal "tmux-256color"'), true);
    assertEquals(config.includes('set-option -ga terminal-overrides ",tmux-256color:Tc"'), true);
    assertEquals(config.includes('set-option -g @catppuccin_flavor "mocha"'), true);
    assertEquals(config.includes('set-option -g @thm_peach "#fab387"'), true);
    assertEquals(config.includes('set-option -g pane-active-border-style "fg=#a6e3a1"'), true);
    assertEquals(config.includes('set-environment -gu NO_COLOR'), true);
    assertEquals(config.includes('set-option -g @weave_config_version weave-tmux-config-v4'), true);
    assertEquals(envs.every((env) => !('NO_COLOR' in env)), true);
    assertEquals(
      calls.some((args) => args.includes('new-session') && args.includes('-s') && args.includes('_weave')),
      true,
    );
    assertEquals(calls.some((args) => args.includes('detach-on-destroy') && args.includes('on')), true);
    assertEquals(calls.some((args) => args.includes('base-index') && args.includes('0')), true);
    assertEquals(calls.some((args) => args.includes('renumber-windows') && args.includes('off')), true);
    assertEquals(calls.some((args) => args.includes('automatic-rename') && args.includes('off')), true);
  } finally {
    await Deno.remove(portalHome, { recursive: true });
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test('TmuxTerminalController recreates _weave when the cached tmux server disappears', async () => {
  const portalHome = await Deno.makeTempDir({ prefix: 'weave-tmux-home-' });
  const calls: string[][] = [];
  const runner = async (args: string[]) => {
    calls.push(args);
    const command = args[4];
    if (command === 'has-session') return { ok: false, stdout: '', stderr: '', code: 1 };
    if (command === 'list-windows') return { ok: true, stdout: '', stderr: '', code: 0 };
    return { ok: true, stdout: '', stderr: '', code: 0 };
  };
  const controller = new TmuxTerminalController({
    portalHome,
    runner,
    env: { WEAVE_PORTAL_TMUX_TERM: 'tmux-256color' },
  });

  try {
    await controller.listAllWindows();
    await controller.listAllWindows();

    assertEquals(calls.filter((args) => args[4] === 'has-session').length, 2);
    assertEquals(calls.filter((args) => args[4] === 'new-session').length, 2);
  } finally {
    await Deno.remove(portalHome, { recursive: true });
  }
});

Deno.test('TmuxTerminalController resets an unmarked existing _weave server once', async () => {
  const portalHome = await Deno.makeTempDir({ prefix: 'weave-tmux-home-' });
  const cwd = await Deno.makeTempDir({ prefix: 'weave-tmux-cwd-' });
  const calls: string[][] = [];
  const runner = async (args: string[]) => {
    calls.push(args);
    const command = args[4];
    if (command === 'has-session') return { ok: true, stdout: '', stderr: '', code: 0 };
    if (command === 'show-option') return { ok: false, stdout: '', stderr: '', code: 1 };
    if (command === 'list-windows') return { ok: true, stdout: '', stderr: '', code: 0 };
    return { ok: true, stdout: '', stderr: '', code: 0 };
  };
  const controller = new TmuxTerminalController({ portalHome, runner });

  try {
    await controller.listWindows(
      {
        kind: 'general',
        cwd,
        cols: 80,
        rows: 24,
        scope: { kind: 'general', cwd },
        scopeId: 'scope',
      } as Parameters<PortalTmuxController['listWindows']>[0],
    );

    const killServerIndex = calls.findIndex((args) => args[4] === 'kill-server');
    const newSessionIndex = calls.findIndex((args) => args[4] === 'new-session');
    assertEquals(killServerIndex >= 0, true);
    assertEquals(newSessionIndex > killServerIndex, true);
  } finally {
    await Deno.remove(portalHome, { recursive: true });
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test('TmuxTerminalController resets an old marked _weave server after color environment upgrade', async () => {
  const portalHome = await Deno.makeTempDir({ prefix: 'weave-tmux-home-' });
  const cwd = await Deno.makeTempDir({ prefix: 'weave-tmux-cwd-' });
  const calls: string[][] = [];
  const runner = async (args: string[]) => {
    calls.push(args);
    const command = args[4];
    if (command === 'has-session') return { ok: true, stdout: '', stderr: '', code: 0 };
    if (command === 'show-option') return { ok: true, stdout: 'weave-tmux-config-v2\n', stderr: '', code: 0 };
    if (command === 'list-windows') return { ok: true, stdout: '', stderr: '', code: 0 };
    return { ok: true, stdout: '', stderr: '', code: 0 };
  };
  const controller = new TmuxTerminalController({ portalHome, runner });

  try {
    await controller.listWindows(
      {
        kind: 'general',
        cwd,
        cols: 80,
        rows: 24,
        scope: { kind: 'general', cwd },
        scopeId: 'scope',
      } as Parameters<PortalTmuxController['listWindows']>[0],
    );

    const killServerIndex = calls.findIndex((args) => args[4] === 'kill-server');
    const newSessionIndex = calls.findIndex((args) => args[4] === 'new-session');
    assertEquals(killServerIndex >= 0, true);
    assertEquals(newSessionIndex > killServerIndex, true);
  } finally {
    await Deno.remove(portalHome, { recursive: true });
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test('TmuxTerminalController preserves a marked existing _weave server and reapplies hardening', async () => {
  const portalHome = await Deno.makeTempDir({ prefix: 'weave-tmux-home-' });
  const cwd = await Deno.makeTempDir({ prefix: 'weave-tmux-cwd-' });
  const calls: string[][] = [];
  const runner = async (args: string[]) => {
    calls.push(args);
    const command = args[4];
    if (command === 'has-session') return { ok: true, stdout: '', stderr: '', code: 0 };
    if (command === 'show-option') return { ok: true, stdout: 'weave-tmux-config-v4\n', stderr: '', code: 0 };
    if (command === 'list-windows') return { ok: true, stdout: '', stderr: '', code: 0 };
    return { ok: true, stdout: '', stderr: '', code: 0 };
  };
  const controller = new TmuxTerminalController({
    portalHome,
    runner,
    env: { WEAVE_PORTAL_TMUX_TERM: 'tmux-256color' },
  });

  try {
    await controller.listWindows(
      {
        kind: 'general',
        cwd,
        cols: 80,
        rows: 24,
        scope: { kind: 'general', cwd },
        scopeId: 'scope',
      } as Parameters<PortalTmuxController['listWindows']>[0],
    );

    assertEquals(calls.some((args) => args[4] === 'kill-server'), false);
    assertEquals(calls.some((args) => args[4] === 'new-session'), false);
    assertEquals(
      calls.some((args) => args.includes('@weave_config_version') && args.includes('weave-tmux-config-v4')),
      true,
    );
    assertEquals(
      calls.some((args) => args.includes('unbind-key') && args.includes('-aT') && args.includes('root')),
      true,
    );
    assertEquals(calls.some((args) => args.includes('prefix') && args.includes('None')), true);
    assertEquals(calls.some((args) => args.includes('default-terminal') && args.includes('tmux-256color')), true);
    assertEquals(calls.some((args) => args.includes('terminal-overrides') && args.includes(',tmux-256color:Tc')), true);
    assertEquals(calls.some((args) => args.includes('detach-on-destroy') && args.includes('on')), true);
    assertEquals(calls.some((args) => args.includes('base-index') && args.includes('0')), true);
    assertEquals(calls.some((args) => args.includes('@catppuccin_flavor') && args.includes('mocha')), true);
    assertEquals(calls.some((args) => args.includes('@thm_peach') && args.includes('#fab387')), true);
    assertEquals(
      calls.some((args) => args.includes('set-environment') && args.includes('-gu') && args.includes('NO_COLOR')),
      true,
    );
  } finally {
    await Deno.remove(portalHome, { recursive: true });
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test('TmuxTerminalController unsets NO_COLOR when launching pane shells', async () => {
  const portalHome = await Deno.makeTempDir({ prefix: 'weave-tmux-home-' });
  const cwd = await Deno.makeTempDir({ prefix: 'weave-tmux-cwd-' });
  const scope = { kind: 'general' as const, cwd };
  const scopeId = testBase64UrlEncode(JSON.stringify(scope));
  const terminalId = `weave:terminal:v1:${scopeId}:slot:1`;
  const calls: string[][] = [];
  const envs: Array<Record<string, string>> = [];
  let created = false;
  let shellCommand = '';
  const runner = async (args: string[], options?: { env?: Record<string, string> }) => {
    calls.push(args);
    envs.push(options?.env ?? {});
    const command = args[4];
    if (command === 'has-session') return { ok: false, stdout: '', stderr: '', code: 1 };
    if (command === 'new-window') {
      created = true;
      shellCommand = args.at(-1) ?? '';
      return { ok: true, stdout: '1\n', stderr: '', code: 0 };
    }
    if (command === 'list-windows') {
      return {
        ok: true,
        stdout: created ? `1\tweave-1-test\t${terminalId}\t${scopeId}\t1\t${cwd}\t\t\n` : '',
        stderr: '',
        code: 0,
      };
    }
    return { ok: true, stdout: '', stderr: '', code: 0 };
  };
  const controller = new TmuxTerminalController({ portalHome, runner, env: { PATH: '/usr/bin:/bin', NO_COLOR: '1' } });

  try {
    const window = await controller.createWindow(
      {
        kind: 'general',
        cwd,
        cols: 80,
        rows: 24,
        scope,
        scopeId,
      } as Parameters<PortalTmuxController['createWindow']>[0],
      {
        env: { TERM: 'tmux-256color', COLORTERM: 'truecolor', PROMPT_EOL_MARK: '' },
        shell: { file: '/bin/zsh', args: [] },
      },
    );

    assertEquals(window.terminalId, terminalId);
    assertEquals(shellCommand.includes("'-u' 'NO_COLOR'"), true);
    assertEquals(shellCommand.includes("'PROMPT_EOL_MARK='"), true);
    assertEquals(envs.every((env) => !('NO_COLOR' in env)), true);
    assertEquals(calls.some((args) => args[4] === 'new-window'), true);
  } finally {
    await Deno.remove(portalHome, { recursive: true });
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test('TmuxTerminalController appends pane cursor position to captured replay', async () => {
  const portalHome = await Deno.makeTempDir({ prefix: 'weave-tmux-home-' });
  const cwd = await Deno.makeTempDir({ prefix: 'weave-tmux-cwd-' });
  const scope = { kind: 'general' as const, cwd };
  const scopeId = testBase64UrlEncode(JSON.stringify(scope));
  const terminalId = `weave:terminal:v1:${scopeId}:slot:1`;
  const calls: string[][] = [];
  const runner = async (args: string[]) => {
    calls.push(args);
    const command = args[4];
    if (command === 'list-windows') {
      return {
        ok: true,
        stdout: [
          '1',
          '@7',
          '%9',
          'Terminal 1',
          terminalId,
          scopeId,
          '1',
          cwd,
          '',
          '',
          '',
          '',
          'zsh',
        ].join('\t'),
        stderr: '',
        code: 0,
      };
    }
    if (command === 'capture-pane') return { ok: true, stdout: 'odin\n❯', stderr: '', code: 0 };
    if (command === 'display-message') return { ok: true, stdout: '0\t2\t1\n', stderr: '', code: 0 };
    return { ok: true, stdout: '', stderr: '', code: 0 };
  };
  const controller = new TmuxTerminalController({ portalHome, runner });

  try {
    assertEquals(await controller.captureWindow(terminalId), 'odin\n❯\x1b[2;3H');
    const captureArgs = calls.find((args) => args[4] === 'capture-pane')?.slice(5) ?? [];
    assertEquals(captureArgs.includes('-S') && captureArgs.includes('0'), true);
    assertEquals(captureArgs.includes('-a'), false);
    assertEquals(
      calls.some((args) => args[4] === 'display-message' && args.includes('#{alternate_on}\t#{cursor_x}\t#{cursor_y}')),
      true,
    );
  } finally {
    await Deno.remove(portalHome, { recursive: true });
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test('TmuxTerminalController captures alternate screen when active', async () => {
  const portalHome = await Deno.makeTempDir({ prefix: 'weave-tmux-home-' });
  const cwd = await Deno.makeTempDir({ prefix: 'weave-tmux-cwd-' });
  const scope = { kind: 'general' as const, cwd };
  const scopeId = testBase64UrlEncode(JSON.stringify(scope));
  const terminalId = `weave:terminal:v1:${scopeId}:slot:1`;
  const calls: string[][] = [];
  const runner = async (args: string[]) => {
    calls.push(args);
    const command = args[4];
    if (command === 'list-windows') {
      return {
        ok: true,
        stdout: [
          '1',
          '@7',
          '%9',
          'Terminal 1',
          terminalId,
          scopeId,
          '1',
          cwd,
          '',
          '',
          '',
          '',
          'top',
        ].join('\t'),
        stderr: '',
        code: 0,
      };
    }
    if (command === 'display-message') return { ok: true, stdout: '1\t4\t3\n', stderr: '', code: 0 };
    if (command === 'capture-pane') return { ok: true, stdout: 'top-screen', stderr: '', code: 0 };
    return { ok: true, stdout: '', stderr: '', code: 0 };
  };
  const controller = new TmuxTerminalController({ portalHome, runner });

  try {
    assertEquals(await controller.captureWindow(terminalId), 'top-screen\x1b[4;5H');
    const captureArgs = calls.find((args) => args[4] === 'capture-pane')?.slice(5);
    assertExists(captureArgs);
    assertEquals(captureArgs.includes('-a'), true);
    assertEquals(captureArgs.includes('-S'), false);
  } finally {
    await Deno.remove(portalHome, { recursive: true });
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test('TmuxTerminalController lists foreground process names and ignores idle shells', async () => {
  const portalHome = await Deno.makeTempDir({ prefix: 'weave-tmux-home-' });
  const cwd = await Deno.makeTempDir({ prefix: 'weave-tmux-cwd-' });
  const scope = { kind: 'general' as const, cwd };
  const scopeId = testBase64UrlEncode(JSON.stringify(scope));
  const firstTerminalId = `weave:terminal:v1:${scopeId}:slot:1`;
  const secondTerminalId = `weave:terminal:v1:${scopeId}:slot:2`;
  const runner = async (args: string[]) => {
    const command = args[4];
    if (command === 'has-session') return { ok: false, stdout: '', stderr: '', code: 1 };
    if (command === 'list-windows') {
      return {
        ok: true,
        stdout: [
          `1\tTerminal 1\t${firstTerminalId}\t${scopeId}\t1\t${cwd}\t\t\t\t\tnvim`,
          `2\tTerminal 2\t${secondTerminalId}\t${scopeId}\t2\t${cwd}\t\t\t\t\tzsh`,
        ].join('\n'),
        stderr: '',
        code: 0,
      };
    }
    return { ok: true, stdout: '', stderr: '', code: 0 };
  };
  const controller = new TmuxTerminalController({ portalHome, runner });

  try {
    const windows = await controller.listAllWindows();
    assertEquals(windows[0].processName, 'nvim');
    assertEquals(windows[1].processName, undefined);
  } finally {
    await Deno.remove(portalHome, { recursive: true });
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test('TmuxTerminalController opens a control-mode client for the durable _weave session', async () => {
  const portalHome = await Deno.makeTempDir({ prefix: 'weave-tmux-home-' });
  const calls: string[][] = [];
  let controlArgs: string[] | undefined;
  const runner = async (args: string[]) => {
    calls.push(args);
    const command = args[4];
    if (command === 'has-session') return { ok: false, stdout: '', stderr: '', code: 1 };
    return { ok: true, stdout: '', stderr: '', code: 0 };
  };
  const controller = new TmuxTerminalController({
    portalHome,
    runner,
    controlClientFactory: (options) => {
      controlArgs = options.args;
      return {
        start: async () => undefined,
        input: async () => undefined,
        resize: async () => undefined,
        continueOutput: async () => undefined,
        close: () => undefined,
      };
    },
  });

  try {
    await controller.openControlClient({
      onOutput: () => undefined,
      onPause: () => undefined,
      onContinue: () => undefined,
      onWindowClose: () => undefined,
      onExit: () => undefined,
      onError: () => undefined,
    });

    assertExists(controlArgs);
    assertEquals(controlArgs.includes('-C'), true);
    assertEquals(controlArgs.includes('attach-session'), true);
    assertEquals(controlArgs.includes('-f'), true);
    assertEquals(controlArgs.includes('pause-after=1'), true);
    assertEquals(controlArgs.at(-1), '_weave');
    assertEquals(controlArgs.some((arg) => arg.includes('_weave_attach')), false);
    assertEquals(calls.some((args) => args[4] === 'link-window'), false);
    assertEquals(calls.some((args) => args[4] === 'unlink-window'), false);
    assertEquals(calls.some((args) => args.includes('_weave_attach_test')), false);
  } finally {
    await Deno.remove(portalHome, { recursive: true });
  }
});

Deno.test('tmux control parser decodes output, extended output, and window close notifications', () => {
  assertEquals(decodeTmuxControlOutputValue('abc\\015\\012\\\\'), 'abc\r\n\\');
  assertEquals(parseTmuxControlNotification('%output %1 hello\\040world'), {
    type: 'output',
    paneId: '%1',
    data: 'hello world',
  });
  assertEquals(parseTmuxControlNotification('%extended-output %2 12 unused : hi\\012'), {
    type: 'output',
    paneId: '%2',
    data: 'hi\n',
  });
  assertEquals(parseTmuxControlNotification('%pause %2'), { type: 'pause', paneId: '%2' });
  assertEquals(parseTmuxControlNotification('%continue %2'), { type: 'continue', paneId: '%2' });
  assertEquals(parseTmuxControlNotification('%window-close @7'), { type: 'window-close', windowId: '@7' });
  assertEquals(parseTmuxControlNotification('%begin 1 2 0'), { type: 'other' });
});

Deno.test('tmux control output decoder preserves UTF-8 split across notifications', () => {
  const decoder = new TmuxControlOutputDecoder();

  assertEquals(decoder.decode('%1', '\\356'), '');
  assertEquals(decoder.decode('%1', '\\202'), '');
  assertEquals(decoder.decode('%1', '\\260'), '');
  assertEquals(decoder.flush('%1'), '');
});

Deno.test('tmux control output decoder keeps pane streams independent', () => {
  const decoder = new TmuxControlOutputDecoder();

  assertEquals(decoder.decode('%1', '\\356'), '');
  assertEquals(decoder.decode('%2', '\\342\\224\\202'), '│');
  assertEquals(decoder.decode('%1', '\\202\\260'), '');
  assertEquals([...decodeTmuxControlOutputBytes('\\033[31m')], [27, 91, 51, 49, 109]);
});

Deno.test('tmux control output decoder removes legacy tmux title sequences', () => {
  const decoder = new TmuxControlOutputDecoder();

  assertEquals(
    decoder.decode('%1', 'before\\033kcd\\033\\134after'),
    'beforeafter',
  );
  assertEquals(decoder.flush('%1'), '');
});

Deno.test('tmux control output decoder removes legacy titles split across notifications', () => {
  const decoder = new TmuxControlOutputDecoder();

  assertEquals(decoder.decode('%1', 'before\\033'), 'before');
  assertEquals(decoder.decode('%1', 'knv'), '');
  assertEquals(decoder.decode('%1', 'im\\033'), '');
  assertEquals(decoder.decode('%1', '\\134after'), 'after');

  assertEquals(decoder.decode('%2', 'color\\033'), 'color');
  assertEquals(decoder.decode('%2', '[31mred'), '\x1b[31mred');
});

Deno.test('terminal input is encoded as byte hex for send-keys -H', () => {
  assertEquals(encodeTerminalInputHex('abc\r\u001b[A'), ['61', '62', '63', '0d', '1b', '5b', '41']);
  assertEquals(encodeTerminalInputHex('é\x1b[200~paste\x1b[201~'), [
    'c3',
    'a9',
    '1b',
    '5b',
    '32',
    '30',
    '30',
    '7e',
    '70',
    '61',
    '73',
    '74',
    '65',
    '1b',
    '5b',
    '32',
    '30',
    '31',
    '7e',
  ]);
});

Deno.test('resolveTmuxDefaultTerminal uses tmux-256color override and falls back without infocmp', async () => {
  assertEquals(await resolveTmuxDefaultTerminal({ WEAVE_PORTAL_TMUX_TERM: 'tmux-256color' }), 'tmux-256color');
  assertEquals(
    await resolveTmuxDefaultTerminal({ WEAVE_PORTAL_TMUX_TERM: 'bad value', PATH: '/definitely/missing' }),
    'screen-256color',
  );
});

Deno.test('TmuxTerminalController reports a clear error when tmux is missing', async () => {
  const portalHome = await Deno.makeTempDir({ prefix: 'weave-tmux-home-' });
  const cwd = await Deno.makeTempDir({ prefix: 'weave-tmux-cwd-' });
  const controller = new TmuxTerminalController({
    portalHome,
    runner: async () => {
      throw new Deno.errors.NotFound('tmux');
    },
  });

  try {
    await controller.listWindows(
      {
        kind: 'general',
        cwd,
        cols: 80,
        rows: 24,
        scope: { kind: 'general', cwd },
        scopeId: 'scope',
      } as Parameters<PortalTmuxController['listWindows']>[0],
    ).then(() => {
      throw new Error('expected tmux missing error');
    }).catch((error) => {
      assertEquals(
        error instanceof Error ? error.message : String(error),
        'tmux is required for Weave terminals but was not found on PATH.',
      );
    });
  } finally {
    await Deno.remove(portalHome, { recursive: true });
    await Deno.remove(cwd, { recursive: true });
  }
});
