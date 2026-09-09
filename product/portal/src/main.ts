import { resolve } from 'node:path';
import { loadPortalConfig } from './config.ts';
import { localAcpSocketPath, runStdioAcpConnector, serveLocalAcpGateway } from './local-acp.ts';
import { Portal } from './portal.ts';
import { PortalSecurity } from './security.ts';
import { startPortalServer } from './server.ts';
import { WorkspaceCatalog } from './workspace-catalog.ts';

const usage = () =>
  `Usage:
  weave-portal serve --config <path>
  weave-portal acp connect --config <path> --agent <agent-id> [--workspace <workspace-id>]
  weave-portal pairing create --config <path> [--ttl-minutes <1-60>]
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
  const [command, subcommand, ...args] = process.argv.slice(2);
  if (command === 'serve') {
    const serveArgs = [subcommand, ...args].filter((value): value is string => value !== undefined);
    const portal = await Portal.open(await configFrom(serveArgs));
    const protocol = portal.config.tls ? 'wss' : 'ws';
    const server = startPortalServer(portal, ({ hostname, port }) => {
      console.log(
        `Weave Portal listening on ${protocol}://${hostname}:${port}`,
      );
    });
    let gateway: Awaited<ReturnType<typeof serveLocalAcpGateway>> | undefined;
    let shutdownTask: Promise<void> | undefined;
    const shutdown = () => {
      shutdownTask ??= (async () => {
        await gateway?.close();
        await server.shutdown();
        await portal.close();
      })();
      return shutdownTask;
    };
    const onSignal = () => void shutdown();
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    try {
      gateway = await serveLocalAcpGateway(portal);
      console.log(`Weave Portal ACP: ${gateway.path}`);
      await Promise.race([server.finished, gateway.finished]);
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      await shutdown();
    }
  } else if (command === 'acp' && subcommand === 'connect') {
    const config = await configFrom(args);
    const agentId = option(args, '--agent');
    if (!agentId) throw new Error(usage());
    const workspaceId = option(args, '--workspace');
    await runStdioAcpConnector({
      path: await localAcpSocketPath(config),
      agentId,
      ...(workspaceId ? { workspaceId } : { workspacePath: process.cwd() }),
    });
  } else if (command === 'pairing' && subcommand === 'create') {
    const config = await configFrom(args);
    const ttlMinutes = Number(option(args, '--ttl-minutes') ?? '5');
    if (!Number.isFinite(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 60) {
      throw new Error(usage());
    }
    const workspaces = (await WorkspaceCatalog.open(
      config.stateDirectory,
      config.workspaces,
    )).list();
    const security = await PortalSecurity.open(
      config,
      workspaces.map(({ workspaceId }) => workspaceId),
    );
    console.log(await security.createPairingToken(ttlMinutes * 60_000));
  } else if (command === 'credential' && subcommand === 'list') {
    const security = await PortalSecurity.open(await configFrom(args));
    console.log(JSON.stringify(await security.listCredentials(), null, 2));
  } else if (command === 'credential' && subcommand === 'revoke') {
    const configIndex = args.indexOf('--config');
    const configPath = configIndex >= 0 ? args[configIndex + 1] : undefined;
    const credentialId = args.find((value, index) =>
      value !== '--config' && index !== configIndex + 1 &&
      !value.startsWith('--')
    );
    if (!configPath || !credentialId) throw new Error(usage());
    const security = await PortalSecurity.open(
      await loadPortalConfig(resolve(configPath)),
    );
    if (!await security.revokeCredential(credentialId)) {
      throw new Error('Credential was not found or was already revoked.');
    }
    console.log(JSON.stringify({ credentialId, revoked: true }));
  } else {
    throw new Error(usage());
  }
}
