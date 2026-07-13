import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1.0.19';
import { createBoundedLogWriter } from './bounded-log.ts';

Deno.test('bounded Portal log stays within its 0600 byte limit', async () => {
  const directory = await Deno.makeTempDir({ prefix: 'weave-portal-log-' });
  const path = `${directory}/desktop-daemon.log`;
  try {
    const writer = createBoundedLogWriter(path, 1_024);
    for (let index = 0; index < 100; index += 1) writer.write('INFO', [`message-${index}`, 'x'.repeat(80)]);
    writer.close();

    const info = await Deno.stat(path);
    assertEquals(info.size <= 1_024, true);
    if (info.mode !== null) assertEquals(info.mode & 0o777, 0o600);
    assertStringIncludes(await Deno.readTextFile(path), 'message-99');
  } finally {
    await Deno.remove(directory, { recursive: true }).catch(() => undefined);
  }
});
