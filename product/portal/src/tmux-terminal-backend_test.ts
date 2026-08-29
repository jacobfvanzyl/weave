import { assertEquals, assertExists } from 'jsr:@std/assert@1.0.19';
import { resolveTmuxExecutable, TmuxTerminalBackend } from './tmux-terminal-backend.ts';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error('Timed out waiting for the tmux Terminal backend.');
};

const tmuxAvailable = async () => {
  try {
    return (await new Deno.Command('tmux', {
      args: ['-V'],
      stdout: 'null',
      stderr: 'null',
    }).output()).success;
  } catch {
    return false;
  }
};

const sparseServiceEnvironment = () => ({
  HOME: Deno.env.get('HOME'),
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  SHELL: '/bin/sh',
});

Deno.test('TmuxTerminalBackend resolves Homebrew tmux outside a launchd PATH', () => {
  const executable = resolveTmuxExecutable(
    { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    {
      os: 'darwin',
      isExecutable: (path) => path === '/opt/homebrew/bin/tmux',
    },
  );

  assertEquals(executable, '/opt/homebrew/bin/tmux');
});

Deno.test('TmuxTerminalBackend honors an explicit tmux executable override', () => {
  const executable = resolveTmuxExecutable(
    {
      PATH: '/usr/bin:/bin',
      WEAVE_PORTAL_TMUX_PATH: '/custom/tools/tmux',
    },
    { isExecutable: () => false },
  );

  assertEquals(executable, '/custom/tools/tmux');
});

Deno.test({
  name: 'TmuxTerminalBackend persists a shell across adapter restarts and supports I/O, capture, resize, and close',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    if (!await tmuxAvailable()) return;
    const stateDirectory = await Deno.makeTempDir({ dir: '/tmp', prefix: 'weave-product-terminal-state-' });
    const cwd = await Deno.makeTempDir({ dir: '/tmp', prefix: 'weave-product-terminal-cwd-' });
    const terminalId = crypto.randomUUID();
    const marker = `__WEAVE_PRODUCT_TERMINAL_${crypto.randomUUID()}__`;
    const output: string[] = [];
    const first = new TmuxTerminalBackend({
      stateDirectory,
      env: sparseServiceEnvironment(),
    });
    const unsubscribe = first.subscribe((event) => {
      if (event.type === 'output') output.push(event.data);
    });

    try {
      const created = await first.create({
        terminalId,
        workspaceId: 'workspace-1',
        cwd,
        cols: 80,
        rows: 24,
        env: {
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          WEAVE_TERMINAL_ID: terminalId,
          WEAVE_WORKSPACE_ID: 'workspace-1',
          WEAVE_WORKSPACE: cwd,
        },
      });
      assertEquals(created.terminalId, terminalId);
      assertEquals(created.workspaceId, 'workspace-1');

      await first.input(terminalId, `printf '${marker}\\n'\r`);
      await waitFor(() => output.join('').includes(marker));
      await first.resize(terminalId, 111, 35);
      const resized = (await first.list()).find((terminal) => terminal.terminalId === terminalId);
      assertExists(resized);
      assertEquals({ cols: resized.cols, rows: resized.rows }, { cols: 111, rows: 35 });
      const captured = await first.capture(terminalId);
      assertEquals(captured.data.includes(marker), true);
      assertEquals(captured.data.startsWith('\x1b[2J\x1b[H'), true);
      const cursor = new TextDecoder().decode(
        (await new Deno.Command('tmux', {
          args: [
            '-S',
            `${stateDirectory}/terminal/tmux.sock`,
            'display-message',
            '-p',
            '-t',
            created.paneId!,
            '#{cursor_x}\t#{cursor_y}',
          ],
        }).output()).stdout,
      ).trim().split('\t').map(Number);
      assertEquals(captured.data.endsWith(`\x1b[${cursor[1] + 1};${cursor[0] + 1}H`), true);

      unsubscribe();
      await first.dispose();

      const reopened = new TmuxTerminalBackend({
        stateDirectory,
        env: sparseServiceEnvironment(),
      });
      try {
        const restored = (await reopened.list()).find((terminal) => terminal.terminalId === terminalId);
        assertExists(restored);
        assertEquals(restored.workspaceId, 'workspace-1');
        assertEquals((await reopened.capture(terminalId)).data.includes(marker), true);
        await reopened.close(terminalId);
        assertEquals((await reopened.list()).some((terminal) => terminal.terminalId === terminalId), false);
      } finally {
        await reopened.dispose();
      }
    } finally {
      unsubscribe();
      await first.close(terminalId).catch(() => undefined);
      await first.dispose();
      await Deno.remove(stateDirectory, { recursive: true }).catch(() => undefined);
      await Deno.remove(cwd, { recursive: true }).catch(() => undefined);
    }
  },
});
