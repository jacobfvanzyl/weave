import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1.0.19';
import { CommandSessionManager } from './command-sessions.ts';

Deno.test('command sessions stream, poll, and retain output offsets', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-command-session-' });
  const sessions = new CommandSessionManager(`${root}/artifacts`);
  try {
    const started = await sessions.start({
      workspaceRoot: root,
      cwd: root,
      command: "printf 'first\\n'; printf 'last\\n' >&2",
      profile: 'host',
      yieldMs: 5_000,
    });
    assertEquals(started.status, 'completed');
    const output = started.events.map((event) => event.text).join('');
    assertStringIncludes(output, 'first');
    assertStringIncludes(output, 'last');
    assertEquals(started.outputBytes, new TextEncoder().encode(output).byteLength);
    assertEquals(started.outputLines, 2);
    const afterFirst = started.events[0].offset + started.events[0].text.length;
    const polled = await sessions.poll(root, started.id, afterFirst);
    assert(polled.events.every((event) => event.offset >= afterFirst));
  } finally {
    sessions.clearForTests();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('command sessions accept stdin and can be cancelled', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-command-stdin-' });
  const sessions = new CommandSessionManager(`${root}/artifacts`);
  try {
    const started = await sessions.start({
      workspaceRoot: root,
      cwd: root,
      command: 'read value; printf "value=%s\\n" "$value"',
      profile: 'host',
      yieldMs: 10,
    });
    assertEquals(started.status, 'running');
    await sessions.write(root, started.id, 'hello\n', true);
    let polled = await sessions.poll(root, started.id);
    for (let attempt = 0; attempt < 50 && polled.status === 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      polled = await sessions.poll(root, started.id);
    }
    assertEquals(polled.status, 'completed');
    assertStringIncludes(polled.events.map((event) => event.text).join(''), 'value=hello');
  } finally {
    sessions.clearForTests();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('oversized command output preserves head and tail and retrieves omitted ranges by offset', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-command-range-' });
  const artifactRoot = `${root}/artifacts`;
  const sessions = new CommandSessionManager(artifactRoot);
  try {
    const started = await sessions.start({
      workspaceRoot: root,
      cwd: root,
      command: "printf 'HEAD'; yes x | head -c 120000; printf 'TAIL'",
      profile: 'host',
      yieldMs: 5_000,
    });
    const visible = started.events.map((event) => event.text).join('');
    assertStringIncludes(visible, 'HEAD');
    assertStringIncludes(visible, 'TAIL');
    assertEquals(started.omittedRanges.length, 1);
    const omitted = started.omittedRanges[0];
    const middle = await sessions.poll(root, started.id, omitted.startOffset, 128);
    assertEquals(middle.events.map((event) => event.text).join('').length, 128);
    assertEquals(middle.hasMore, true);
    sessions.clearForTests();
    const restored = await new CommandSessionManager(artifactRoot).poll(root, started.id, omitted.startOffset, 128);
    assertEquals(
      restored.events.map((event) => event.text).join(''),
      middle.events.map((event) => event.text).join(''),
    );
  } finally {
    sessions.clearForTests();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('command sessions enforce timeout, cancellation, and PTY execution', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-command-control-' });
  const sessions = new CommandSessionManager(`${root}/artifacts`);
  try {
    const timedOut = await sessions.start({
      workspaceRoot: root,
      cwd: root,
      command: 'sleep 5',
      profile: 'host',
      timeoutMs: 30,
      yieldMs: 1_000,
    });
    assertEquals(timedOut.status, 'timed_out');
    assertEquals(timedOut.timedOut, true);

    const running = await sessions.start({
      workspaceRoot: root,
      cwd: root,
      command: 'sleep 5',
      profile: 'host',
      yieldMs: 10,
    });
    assertEquals(running.status, 'running');
    sessions.stop(root, running.id);
    let cancelled = await sessions.poll(root, running.id);
    for (let attempt = 0; attempt < 50 && !cancelled.finishedAt; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      cancelled = await sessions.poll(root, running.id);
    }
    assertEquals(cancelled.status, 'cancelled');

    const pty = await sessions.start({
      workspaceRoot: root,
      cwd: root,
      command: "printf 'pty-ok\\n'",
      profile: 'host',
      pty: true,
      yieldMs: 5_000,
    });
    assertEquals(pty.status, 'completed');
    assertEquals(pty.pty, true);
    assertStringIncludes(pty.events.map((event) => event.text).join(''), 'pty-ok');
  } finally {
    sessions.clearForTests();
    await Deno.remove(root, { recursive: true });
  }
});
