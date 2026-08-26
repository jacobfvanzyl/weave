import { resolve } from 'jsr:@std/path@1.1.2';
import { loadPortalConfig } from './config.ts';
import { Portal } from './portal.ts';
import { PortalSecurity } from './security.ts';
import { startPortalServer } from './server.ts';

const usage = () =>
  `Usage:
  weave-portal serve --config <path>
  weave-portal pairing create --config <path> --name <device-name> [--ttl-minutes <1-60>]
  weave-portal credential list --config <path>
  weave-portal credential revoke --config <path> <credential-id>`;

const option = (args: string[], name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const configFrom = async (args: string[]) => {
  const configPath = option(args, '--config');
  if (!configPath) throw new Error(usage());
  return await loadPortalConfig(resolve(configPath));
};

if (import.meta.main) {
  const [command, subcommand, ...args] = Deno.args;
  if (command === 'serve') {
    const serveArgs = [subcommand, ...args].filter((value): value is string => value !== undefined);
    const portal = await Portal.open(await configFrom(serveArgs));
    const protocol = portal.config.tls ? 'wss' : 'ws';
    const server = startPortalServer(portal, ({ hostname, port }) => {
      console.log(`Weave Portal listening on ${protocol}://${hostname}:${port}`);
    });
    const shutdown = async () => {
      await server.shutdown();
      await portal.close();
    };
    Deno.addSignalListener('SIGINT', shutdown);
    Deno.addSignalListener('SIGTERM', shutdown);
    await server.finished;
  } else if (command === 'pairing' && subcommand === 'create') {
    const config = await configFrom(args);
    const name = option(args, '--name');
    if (!name) throw new Error(usage());
    const ttlMinutes = Number(option(args, '--ttl-minutes') ?? '5');
    if (!Number.isFinite(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 60) throw new Error(usage());
    const security = await PortalSecurity.open(config);
    console.log(JSON.stringify(await security.createPairingOffer(name, ttlMinutes * 60_000)));
  } else if (command === 'credential' && subcommand === 'list') {
    const security = await PortalSecurity.open(await configFrom(args));
    console.log(JSON.stringify(await security.listCredentials(), null, 2));
  } else if (command === 'credential' && subcommand === 'revoke') {
    const configIndex = args.indexOf('--config');
    const configPath = configIndex >= 0 ? args[configIndex + 1] : undefined;
    const credentialId = args.find((value, index) =>
      value !== '--config' && index !== configIndex + 1 && !value.startsWith('--')
    );
    if (!configPath || !credentialId) throw new Error(usage());
    const security = await PortalSecurity.open(await loadPortalConfig(resolve(configPath)));
    if (!await security.revokeCredential(credentialId)) {
      throw new Error('Credential was not found or was already revoked.');
    }
    console.log(JSON.stringify({ credentialId, revoked: true }));
  } else {
    throw new Error(usage());
  }
}
