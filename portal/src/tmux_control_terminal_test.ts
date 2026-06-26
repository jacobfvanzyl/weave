import { assert, assertEquals } from 'jsr:@std/assert@1.0.19';
import { PortalTerminalHost, type TerminalHostEvent, TmuxTerminalController } from './terminal.ts';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const makeShortTempDir = (prefix: string) => Deno.makeTempDir({ dir: '/tmp', prefix });

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error('Timed out waiting for tmux control terminal condition.');
};

const commandExists = async (command: string) => {
  const output = await new Deno.Command('sh', {
    args: ['-lc', `command -v ${command}`],
    stdout: 'null',
    stderr: 'null',
  }).output();
  return output.success;
};

const portalCommandExists = async (command: string, args: string[] = []) => {
  try {
    const output = await new Deno.Command(command, {
      args,
      env: Deno.env.toObject(),
      stdout: 'null',
      stderr: 'null',
    }).output();
    return output.success;
  } catch {
    return false;
  }
};

const createHost = (portalHome: string, env: Record<string, string | undefined>) =>
  new PortalTerminalHost({
    config: {},
    tmux: new TmuxTerminalController({ portalHome, env }),
    outputBatchMs: 1,
    env,
  });

const runTmux = async (portalHome: string, args: string[]) =>
  await new Deno.Command('tmux', {
    args: [
      '-f',
      `${portalHome}/tmux/tmux.conf`,
      '-S',
      `${portalHome}/tmux/_weave.sock`,
      ...args,
    ],
    stdout: 'piped',
    stderr: 'piped',
  }).output();

const listTmuxSessions = async (portalHome: string) => {
  const output = await runTmux(portalHome, ['list-sessions', '-F', '#{session_name}']);
  if (!output.success) return [];
  return new TextDecoder().decode(output.stdout).trim().split('\n').filter(Boolean);
};

const killTmuxServer = async (portalHome: string) => {
  await runTmux(portalHome, ['kill-server']).catch(() => undefined);
};

Deno.test({
  name: 'Portal tmux terminal starts a shell, writes output, resizes, and closes',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    if (!await portalCommandExists('tmux', ['-V'])) return;
    const cwd = await makeShortTempDir('wtc-');
    const portalHome = await makeShortTempDir('wth-');
    const events: TerminalHostEvent[] = [];
    const env = { ...Deno.env.toObject(), SHELL: '/bin/sh' };
    const host = createHost(portalHome, env);

    try {
      await host.handleClientMessage('client-1', {
        type: 'create',
        kind: 'general',
        cwd,
        cols: 80,
        rows: 24,
      }, (event) => events.push(event));
      const created = events.find((event) => event.type === 'created')?.window;
      if (!created) throw new Error(`terminal was not created: ${JSON.stringify(events)}`);

      await host.handleClientMessage('client-1', {
        type: 'start',
        kind: 'general',
        terminalId: created.terminalId,
        cwd,
        cols: 80,
        rows: 24,
      }, (event) => events.push(event));

      await waitFor(() => events.some((event) => event.type === 'started'));
      assertEquals(events.some((event) => event.type === 'started'), true);
      await host.handleClientMessage('client-1', {
        type: 'input',
        terminalId: created.terminalId,
        data: 'printf "__WEAVE_TMUX_CONTROL_OK__\\n"\r',
      }, (event) => events.push(event));
      await waitFor(() =>
        events.some((event) => event.type === 'output' && event.data.includes('__WEAVE_TMUX_CONTROL_OK__'))
      );

      await host.handleClientMessage('client-1', {
        type: 'resize',
        terminalId: created.terminalId,
        cols: 120,
        rows: 32,
      }, (event) => events.push(event));
      await host.handleClientMessage('client-1', {
        type: 'detach',
        terminalId: created.terminalId,
      }, (event) => events.push(event));

      const listEvents: TerminalHostEvent[] = [];
      await host.handleClientMessage('client-2', {
        type: 'list',
        kind: 'general',
        cwd,
      }, (event) => listEvents.push(event));
      const listed = listEvents.find((event) => event.type === 'windows');
      assertEquals(listed?.type === 'windows' ? listed.windows.length : 0, 1);

      const reopenEvents: TerminalHostEvent[] = [];
      await host.handleClientMessage('client-2', {
        type: 'start',
        kind: 'general',
        terminalId: created.terminalId,
        cwd,
        cols: 120,
        rows: 32,
      }, (event) => reopenEvents.push(event));
      assertEquals(reopenEvents.some((event) => event.type === 'started'), true);
      assertEquals(
        reopenEvents.some((event) => event.type === 'replay' && event.data.includes('__WEAVE_TMUX_CONTROL_OK__')),
        true,
      );

      await host.handleClientMessage('client-2', {
        type: 'input',
        terminalId: created.terminalId,
        data: 'printf "__WEAVE_TMUX_CONTROL_REOPEN__\\n"\r',
      }, (event) => reopenEvents.push(event));
      await waitFor(() =>
        reopenEvents.some((event) => event.type === 'output' && event.data.includes('__WEAVE_TMUX_CONTROL_REOPEN__'))
      );
      assertEquals(await listTmuxSessions(portalHome), ['_weave']);

      await host.handleClientMessage('client-1', {
        type: 'close',
        terminalId: created.terminalId,
      }, (event) => events.push(event));
      await waitFor(() => reopenEvents.some((event) => event.type === 'exit'));
    } finally {
      host.dispose();
      await killTmuxServer(portalHome);
      await Deno.remove(cwd, { recursive: true });
      await Deno.remove(portalHome, { recursive: true });
    }
  },
});

Deno.test({
  name: 'Portal tmux control terminal can run btop and accept q when available',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    if (!await portalCommandExists('tmux', ['-V'])) return;
    if (!await commandExists('btop')) return;

    const cwd = await makeShortTempDir('wtb-');
    const portalHome = await makeShortTempDir('wbh-');
    const events: TerminalHostEvent[] = [];
    let terminalId: string | undefined;
    const env = { ...Deno.env.toObject(), SHELL: '/bin/sh' };
    const host = createHost(portalHome, env);

    try {
      await host.handleClientMessage('client-1', {
        type: 'create',
        kind: 'general',
        cwd,
        cols: 120,
        rows: 40,
      }, (event) => events.push(event));
      const created = events.find((event) => event.type === 'created')?.window;
      if (!created) throw new Error(`terminal was not created: ${JSON.stringify(events)}`);
      terminalId = created.terminalId;

      await host.handleClientMessage('client-1', {
        type: 'start',
        kind: 'general',
        terminalId: created.terminalId,
        cwd,
        cols: 120,
        rows: 40,
      }, (event) => events.push(event));
      await waitFor(() => events.some((event) => event.type === 'started'));

      await host.handleClientMessage('client-1', {
        type: 'input',
        terminalId: created.terminalId,
        data: 'btop; printf "__WEAVE_BTOP_EXITED__\\n"\r',
      }, (event) => events.push(event));
      await waitFor(() => events.some((event) => event.type === 'output' && event.data.length > 200), 8_000);
      await host.handleClientMessage('client-1', {
        type: 'input',
        terminalId: created.terminalId,
        data: 'q',
      }, (event) => events.push(event));
      await waitFor(
        () => events.some((event) => event.type === 'output' && event.data.includes('__WEAVE_BTOP_EXITED__')),
        8_000,
      );
      assert(events.some((event) => event.type === 'output' && event.data.includes('__WEAVE_BTOP_EXITED__')));
    } finally {
      if (terminalId) {
        await host.handleClientMessage('client-1', { type: 'close', terminalId }, () => undefined);
      }
      host.dispose();
      await killTmuxServer(portalHome);
      await Deno.remove(cwd, { recursive: true });
      await Deno.remove(portalHome, { recursive: true });
    }
  },
});
