import { resolve } from 'jsr:@std/path@1.1.2';
import { loadPortalConfig } from './config.ts';
import { Portal } from './portal.ts';
import { startPortalServer } from './server.ts';

const usage = () => 'Usage: weave-portal serve --config <absolute-or-relative-path>';

if (import.meta.main) {
  const [command, ...args] = Deno.args;
  if (command !== 'serve') throw new Error(usage());
  const configIndex = args.indexOf('--config');
  const configPath = configIndex >= 0 ? args[configIndex + 1] : undefined;
  if (!configPath) throw new Error(usage());
  const portal = await Portal.open(await loadPortalConfig(resolve(configPath)));
  const server = startPortalServer(portal, ({ hostname, port }) => {
    console.log(`Weave Portal listening on ws://${hostname}:${port}`);
  });
  const shutdown = async () => {
    await server.shutdown();
    await portal.close();
  };
  Deno.addSignalListener('SIGINT', shutdown);
  Deno.addSignalListener('SIGTERM', shutdown);
  await server.finished;
}
