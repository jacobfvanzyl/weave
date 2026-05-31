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

Deno.test({
  name: 'Portal native PTY starts a shell, writes output, resizes, and closes',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    const cwd = await Deno.makeTempDir({ prefix: 'weave-native-pty-' });
    const events: TerminalHostEvent[] = [];
    const host = new PortalTerminalHost({
      config: {},
      outputBatchMs: 1,
      env: { ...Deno.env.toObject(), SHELL: '/bin/sh' },
    });

    try {
      await host.handleClientMessage('client-1', {
        type: 'start',
        kind: 'general',
        terminalId: 'native-smoke',
        cwd,
        cols: 80,
        rows: 24,
      }, (event) => events.push(event));

      assertEquals(events[0]?.type, 'started');
      await host.handleClientMessage('client-1', {
        type: 'input',
        terminalId: 'native-smoke',
        data: 'printf "__WEAVE_NATIVE_PTY_OK__\\n"\r',
      }, (event) => events.push(event));
      await waitFor(() =>
        events.some((event) => event.type === 'output' && event.data.includes('__WEAVE_NATIVE_PTY_OK__'))
      );

      await host.handleClientMessage('client-1', {
        type: 'resize',
        terminalId: 'native-smoke',
        cols: 120,
        rows: 32,
      }, (event) => events.push(event));
      await host.handleClientMessage('client-1', {
        type: 'input',
        terminalId: 'native-smoke',
        data: 'exit\r',
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
    if (!await commandExists('btop')) return;

    const cwd = await Deno.makeTempDir({ prefix: 'weave-native-btop-' });
    const events: TerminalHostEvent[] = [];
    const host = new PortalTerminalHost({
      config: {},
      outputBatchMs: 1,
      env: { ...Deno.env.toObject(), SHELL: '/bin/sh' },
    });

    try {
      await host.handleClientMessage('client-1', {
        type: 'start',
        kind: 'general',
        terminalId: 'native-btop',
        cwd,
        cols: 120,
        rows: 40,
      }, (event) => events.push(event));

      await host.handleClientMessage('client-1', {
        type: 'input',
        terminalId: 'native-btop',
        data: 'btop; printf "__WEAVE_BTOP_EXITED__\\n"\r',
      }, (event) => events.push(event));
      await waitFor(() => events.some((event) => event.type === 'output' && event.data.length > 200), 8_000);
      await host.handleClientMessage('client-1', {
        type: 'input',
        terminalId: 'native-btop',
        data: 'q',
      }, (event) => events.push(event));
      await waitFor(
        () => events.some((event) => event.type === 'output' && event.data.includes('__WEAVE_BTOP_EXITED__')),
        8_000,
      );
      assert(events.some((event) => event.type === 'output' && event.data.includes('__WEAVE_BTOP_EXITED__')));
    } finally {
      host.dispose();
      await Deno.remove(cwd, { recursive: true });
    }
  },
});
