// Disposable Host for the real-shell Client Browser Workspace acceptance path.
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Portal } from '../../portal/src/portal.ts';
import { startPortalServer } from '../../portal/src/server.ts';
import { TerminalServiceConnection } from '../../portal/src/terminal-service/connection.ts';
const root = resolve(process.env.WEAVE_CLIENT_BROWSER_ACCEPTANCE_DIR ?? '/tmp/weave-wve80-workspace');
await mkdir(root, { recursive: true, mode: 0o700 });
const directory = join(root, 'workspace'); await mkdir(directory, { recursive: true });
const hostname = process.env.WEAVE_CLIENT_BROWSER_ACCEPTANCE_BIND ?? '127.0.0.1';
const certificateFile = process.env.WEAVE_CLIENT_BROWSER_TLS_CERT, privateKeyFile = process.env.WEAVE_CLIENT_BROWSER_TLS_KEY;
const tls = certificateFile && privateKeyFile ? { certificateFile, privateKeyFile } : undefined;
if (!['127.0.0.1', 'localhost'].includes(hostname) && !tls) throw new Error('Off-device acceptance requires TLS.');
const publicName = process.env.WEAVE_CLIENT_BROWSER_ACCEPTANCE_HOSTNAME ?? hostname;
const terminalBackend = new TerminalServiceConnection({ stateDirectory: join(root, 'state') });
const portal = await Portal.open({ listen: { hostname, port: 0 }, displayName: 'Client Browser acceptance', allowedOrigins: ['weave://app', 'capacitor://localhost'], ...(tls ? { tls } : {}), stateDirectory: join(root, 'state'), executionContexts: [{ executionContextId: 'acceptance', name: 'Client Browser acceptance', path: directory }], agents: [] }, { terminalBackend, browserBackend: false });
const server = startPortalServer(portal);
for (const device of ['mac', 'ipad']) {
  const pairingToken = await portal.security.createPairingToken(30 * 60 * 1000);
  await writeFile(join(root, `${device}-input.json`), JSON.stringify({ hostUrl: `${tls ? 'wss' : 'ws'}://${publicName}:${server.addr.port}`, pairingToken, workspaceName: 'Client Browser acceptance', directory: await realpath(directory), clientBrowserWorkspace: true, ...(process.env.WEAVE_CLIENT_BROWSER_RECOVERY_URL ? { clientBrowserRecovery: process.env.WEAVE_CLIENT_BROWSER_RECOVERY_URL } : {}) }), { mode: 0o600 });
}
console.log(`Client Browser acceptance Host ready; private inputs in ${root}`);
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void (async () => { await server.shutdown(); for (const terminal of await terminalBackend.client.list()) await terminalBackend.client.request({ method: 'close', terminalId: terminal.terminalId }); await terminalBackend.client.request({ method: 'shutdown' }); await portal.close(); process.exit(0); })(); });
await new Promise(() => {});
