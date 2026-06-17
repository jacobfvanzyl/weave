import { assert, assertEquals } from 'jsr:@std/assert@1.0.19';
import { PortalTerminalHost, type TerminalHostEvent } from './terminal.ts';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error('Timed out waiting for native PTY smoke condition.');
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

Deno.test({
  name: 'Portal tmux terminal starts a shell, writes output, resizes, and closes',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    if (!await portalCommandExists('tmux', ['-V'])) return;
    const cwd = await Deno.makeTempDir({ prefix: 'weave-native-pty-' });
    const events: TerminalHostEvent[] = [];
    const host = new PortalTerminalHost({
      config: {},
      outputBatchMs: 1,
      env: { ...Deno.env.toObject(), SHELL: '/bin/sh' },
    });

    try {
      await host.handleClientMessage('client-1', {
        type: 'create',
        kind: 'general',
        cwd,
        cols: 80,
        rows: 24,
      }, (event) => events.push(event));
      const created = events.find((event) => event.type === 'created')?.window;
      if (!created) throw new Error('terminal was not created');

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
        data: 'printf "__WEAVE_NATIVE_PTY_OK__\\n"\r',
      }, (event) => events.push(event));
      await waitFor(() =>
        events.some((event) => event.type === 'output' && event.data.includes('__WEAVE_NATIVE_PTY_OK__'))
      );

      await host.handleClientMessage('client-1', {
        type: 'resize',
        terminalId: created.terminalId,
        cols: 120,
        rows: 32,
      }, (event) => events.push(event));
      await host.handleClientMessage('client-1', {
        type: 'close',
        terminalId: created.terminalId,
      }, (event) => events.push(event));
      await waitFor(() => events.some((event) => event.type === 'exit'));
    } finally {
      host.dispose();
      await Deno.remove(cwd, { recursive: true });
    }
  },
});

Deno.test({
  name: 'Portal native PTY can run btop and accept q when available',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    if (!await portalCommandExists('tmux', ['-V'])) return;
    if (!await commandExists('btop')) return;

    const cwd = await Deno.makeTempDir({ prefix: 'weave-native-btop-' });
    const events: TerminalHostEvent[] = [];
    let terminalId: string | undefined;
    const host = new PortalTerminalHost({
      config: {},
      outputBatchMs: 1,
      env: { ...Deno.env.toObject(), SHELL: '/bin/sh' },
    });

    try {
      await host.handleClientMessage('client-1', {
        type: 'create',
        kind: 'general',
        cwd,
        cols: 120,
        rows: 40,
      }, (event) => events.push(event));
      const created = events.find((event) => event.type === 'created')?.window;
      if (!created) throw new Error('terminal was not created');
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
      await Deno.remove(cwd, { recursive: true });
    }
  },
});
