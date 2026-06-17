import { assertEquals, assertExists } from 'jsr:@std/assert@1.0.19';
import {
  type PortalPty,
  type PortalPtyExitEvent,
  type PortalPtySpawner,
  PortalTerminalHost,
  type PortalTmuxAttachCommand,
  type PortalTmuxController,
  startTerminalControlServer,
  type TerminalHostEvent,
  type TerminalWindowRecord,
  TmuxTerminalController,
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

type FakeTmuxWindow = TerminalWindowRecord & {
  scopeId: string;
  attachCount: number;
};

class FakeTmux implements PortalTmuxController {
  windows: FakeTmuxWindow[] = [];
  killedWindows: string[] = [];
  killedAttachments: string[] = [];
  createdEnvs: Record<string, string>[] = [];

  async listAllWindows() {
    return this.windows
      .sort((left, right) =>
        left.scopeId.localeCompare(right.scopeId)
        || left.slot - right.slot
        || left.terminalId.localeCompare(right.terminalId)
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
    if (duplicate) return this.toRecord(duplicate);
    this.createdEnvs.push({ ...input.env, WEAVE_TERMINAL_ID: terminalId });
    const window = {
      terminalId,
      slot,
      kind: target.kind,
      cwd: target.cwd,
      title: `Terminal ${slot}`,
      portalId: target.portalId,
      rootId: target.rootId,
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      scopeId: target.scopeId,
      attachCount: 0,
    };
    this.windows.push(window);
    return this.toRecord(window);
  }

  async ensureWindow(
    target: Parameters<PortalTmuxController['ensureWindow']>[0],
    input: Parameters<PortalTmuxController['ensureWindow']>[1],
  ) {
    const existing = this.windows.find((window) => window.terminalId === input.terminalId);
    if (existing) return this.toRecord(existing);
    const slot = Number(input.terminalId.split(':slot:').at(-1));
    return await this.createWindow(target, {
      env: input.env,
      shell: input.shell,
      slot: Number.isInteger(slot) && slot > 0 ? slot : 1,
    });
  }

  async getAttachCommand(terminalId: string, clientId: string): Promise<PortalTmuxAttachCommand> {
    const window = this.windows.find((item) => item.terminalId === terminalId);
    if (!window) throw new Error('Terminal tmux window is not running.');
    window.attachCount += 1;
    return {
      attachSessionId: `attach-${clientId}-${window.attachCount}`,
      file: 'tmux',
      args: ['attach', terminalId],
      cwd: window.cwd,
      env: { TERM: 'xterm-256color' },
    };
  }

  async killAttachment(attachSessionId: string) {
    this.killedAttachments.push(attachSessionId);
  }

  async killWindow(terminalId: string) {
    this.killedWindows.push(terminalId);
    this.windows = this.windows.filter((window) => window.terminalId !== terminalId);
  }

  async captureWindow() {
    return '';
  }

  private toRecord = (window: FakeTmuxWindow): TerminalWindowRecord => ({
    terminalId: window.terminalId,
    scopeId: window.scopeId,
    slot: window.slot,
    kind: window.kind,
    cwd: window.cwd,
    title: window.title,
    ...(window.processName ? { processName: window.processName } : {}),
    portalId: window.portalId,
    rootId: window.rootId,
    projectId: window.projectId,
    workspaceId: window.workspaceId,
  });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const testBase64UrlEncode = (value: string) => btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const withHost = async (
  callback: (context: {
    cwd: string;
    host: PortalTerminalHost;
    ptys: FakePty[];
    tmux: FakeTmux;
    spawnOptions: Array<{ cols: number; rows: number; cwd: string; env: Record<string, string> }>;
  }) => Promise<void>,
  tmux = new FakeTmux(),
) => {
  const cwd = await Deno.makeTempDir({ prefix: 'weave-terminal-' });
  const realCwd = await Deno.realPath(cwd);
  const ptys: FakePty[] = [];
  const spawnOptions: Array<{ cols: number; rows: number; cwd: string; env: Record<string, string> }> = [];
  const spawner: PortalPtySpawner = (_file, _args, options) => {
    const pty = new FakePty();
    spawnOptions.push(options);
    ptys.push(pty);
    return pty;
  };
  const host = new PortalTerminalHost({
    config: {},
    spawner,
    tmux,
    outputBatchMs: 1,
    replayLimitBytes: 1024,
    env: { SHELL: '/bin/test-shell' },
  });

  try {
    await callback({ cwd: realCwd, host, ptys, tmux, spawnOptions });
  } finally {
    host.dispose();
    await Deno.remove(cwd, { recursive: true });
  }
};

Deno.test('PortalTerminalHost creates deterministic tmux windows and restores them after host restart', async () => {
  const cwd = await Deno.makeTempDir({ prefix: 'weave-terminal-' });
  const realCwd = await Deno.realPath(cwd);
  const tmux = new FakeTmux();
  const ptys: FakePty[] = [];
  const spawner: PortalPtySpawner = (_file, _args, options) => {
    const pty = new FakePty();
    ptys.push(pty);
    assertEquals(options.cwd, realCwd);
    return pty;
  };
  const createHost = () =>
    new PortalTerminalHost({
      config: {},
      spawner,
      tmux,
      outputBatchMs: 1,
      replayLimitBytes: 1024,
      env: { SHELL: '/bin/test-shell' },
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
    assertEquals(ptys.length, 1);
    assertEquals(startEvents[0], {
      type: 'started',
      terminalId: created.terminalId,
      workspaceId: 'workspace-1',
      sessionId: created.terminalId,
      cwd: realCwd,
      pid: 4242,
      cols: 100,
      rows: 30,
    });
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
    attachCount: 0,
  });
  const host = new PortalTerminalHost({
    config: {
      portalId: 'portal-1',
      roots: [{ id: 'default', path: realCwd }],
    },
    tmux,
    env: { SHELL: '/bin/test-shell' },
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
      windows: [{ ...legacyWindow, portalId: undefined, rootId: undefined, projectId: undefined, workspaceId: undefined }],
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
    env: { SHELL: '/bin/test-shell' },
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
    assertEquals('WEAVE_PLANE_ID' in tmux.createdEnvs[0], false);
    assertEquals('WEAVE_DEMIPLANE_ID' in tmux.createdEnvs[0], false);
  }));

Deno.test('PortalTerminalHost routes input, resize, detach, close, and exit', async () =>
  withHost(async ({ cwd, host, ptys, tmux }) => {
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

    assertExists(ptys[0]);
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
    assertEquals(ptys[0].writes, ['pwd\r']);
    assertEquals(ptys[0].resizes, [{ cols: 132, rows: 40 }]);

    await host.handleClientMessage(
      'client-1',
      { type: 'detach', terminalId: created.terminalId },
      (event) => events.push(event),
    );
    assertEquals(tmux.windows.length, 1);
    assertEquals(ptys[0].closed, true);
    ptys[0].emitData('after detach');
    await delay(5);
    assertEquals(events.some((event) => event.type === 'output' && event.data === 'after detach'), false);

    await host.handleClientMessage(
      'client-2',
      { type: 'start', kind: 'general', terminalId: created.terminalId, cwd },
      (event) => events.push(event),
    );
    assertEquals(ptys.length, 2);
    await host.handleClientMessage(
      'client-2',
      { type: 'close', terminalId: created.terminalId },
      (event) => events.push(event),
    );
    assertEquals(tmux.windows.length, 0);
    assertEquals(events.at(-1), {
      type: 'exit',
      terminalId: created.terminalId,
      workspaceId: undefined,
      exitCode: undefined,
      signal: undefined,
    });
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
  const controller = new TmuxTerminalController({ portalHome, runner, env: { PATH: '/usr/bin:/bin', NO_COLOR: '1' } });

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
    assertEquals(config.includes('set-option -g default-terminal "xterm-256color"'), true);
    assertEquals(config.includes('set-option -ga terminal-overrides ",xterm-256color:Tc"'), true);
    assertEquals(config.includes('set-option -g @catppuccin_flavor "mocha"'), true);
    assertEquals(config.includes('set-option -g @thm_peach "#fab387"'), true);
    assertEquals(config.includes('set-option -g pane-active-border-style "fg=#a6e3a1"'), true);
    assertEquals(config.includes('set-environment -gu NO_COLOR'), true);
    assertEquals(config.includes('set-option -g @weave_config_version weave-tmux-config-v3'), true);
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
  const controller = new TmuxTerminalController({ portalHome, runner });

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
    if (command === 'show-option') return { ok: true, stdout: 'weave-tmux-config-v3\n', stderr: '', code: 0 };
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

    assertEquals(calls.some((args) => args[4] === 'kill-server'), false);
    assertEquals(calls.some((args) => args[4] === 'new-session'), false);
    assertEquals(
      calls.some((args) => args.includes('@weave_config_version') && args.includes('weave-tmux-config-v3')),
      true,
    );
    assertEquals(
      calls.some((args) => args.includes('unbind-key') && args.includes('-aT') && args.includes('root')),
      true,
    );
    assertEquals(calls.some((args) => args.includes('prefix') && args.includes('None')), true);
    assertEquals(calls.some((args) => args.includes('default-terminal') && args.includes('xterm-256color')), true);
    assertEquals(calls.some((args) => args.includes('terminal-overrides') && args.includes('xterm-256color:Tc')), true);
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
        env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        shell: { file: '/bin/zsh', args: [] },
      },
    );

    assertEquals(window.terminalId, terminalId);
    assertEquals(shellCommand.includes("'-u' 'NO_COLOR'"), true);
    assertEquals(envs.every((env) => !('NO_COLOR' in env)), true);
    assertEquals(calls.some((args) => args[4] === 'new-window'), true);
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

Deno.test('TmuxTerminalController attaches through an isolated single-window session', async () => {
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
        stdout: `7\tTerminal 1\t${terminalId}\t${scopeId}\t1\t${cwd}\t\t\t\t\tzsh\n`,
        stderr: '',
        code: 0,
      };
    }
    return { ok: true, stdout: '', stderr: '', code: 0 };
  };
  const controller = new TmuxTerminalController({ portalHome, runner });

  try {
    const attach = await controller.getAttachCommand(terminalId, 'client-1');
    const attachSessionId = attach.attachSessionId;

    assertEquals(attach.args.includes('attach-session'), true);
    assertEquals(attach.args.at(-1), attachSessionId);
    assertEquals(
      calls.some((args) => args[4] === 'new-session' && args.includes('-t') && args.includes('_weave')),
      false,
    );
    assertExists(calls.find((args) => args[4] === 'new-session' && args.includes('-s') && args.includes(attachSessionId)));
    assertEquals(
      calls.some((args) =>
        args[4] === 'set-option' &&
        args.includes('-t') &&
        args.includes(attachSessionId) &&
        args.includes('detach-on-destroy') &&
        args.includes('on')
      ),
      true,
    );
    assertEquals(
      calls.some((args) =>
        args[4] === 'link-window' &&
        args.includes('-k') &&
        args.includes('-s') &&
        args.includes('_weave:7') &&
        args.includes('-t') &&
        args.includes(`${attachSessionId}:0`)
      ),
      true,
    );
    assertEquals(
      calls.some((args) => args[4] === 'select-window' && args.includes(`${attachSessionId}:0`)),
      true,
    );
  } finally {
    await Deno.remove(portalHome, { recursive: true });
    await Deno.remove(cwd, { recursive: true });
  }
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
