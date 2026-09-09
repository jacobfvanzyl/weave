import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { AgentProcess } from './agent-process.ts';
import type { PortalConfig } from './config.ts';
import { hostVersion } from './version.ts';

type Check = { area: string; subject: string; ok: boolean; detail: string };
export async function diagnose(config: PortalConfig, url?: string) {
  const checks: Check[] = [];
  const check = async (area: string, subject: string, work: () => Promise<string>) => {
    try { checks.push({ area, subject, ok: true, detail: await work() }); }
    catch (error) { checks.push({ area, subject, ok: false, detail: error instanceof Error ? error.message : String(error) }); }
  };
  await check('host', 'state directory', async () => {
    const info = await stat(config.stateDirectory);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error('State must be an owned, private directory.');
    await access(config.stateDirectory, constants.R_OK | constants.W_OK);
    return 'State exists and is private and writable.';
  });
  for (const workspace of config.workspaces) await check('filesystem', workspace.workspaceId, async () => {
    if (!(await stat(workspace.path)).isDirectory()) throw new Error('Workspace is not a directory.');
    await access(workspace.path, constants.R_OK | constants.X_OK);
    return 'Workspace directory is accessible.';
  });
  await check('terminal', 'tmux', async () => {
    if (!Bun.which('tmux')) throw new Error('tmux is missing from the service PATH.');
    const child = Bun.spawn(['tmux', '-V'], { stdout: 'pipe', stderr: 'pipe' });
    const output = await new Response(child.stdout).text();
    if (await child.exited !== 0) throw new Error('tmux could not start.');
    return output.trim();
  });
  await check('trust', 'TLS and allowed origins', async () => {
    if (config.tls) {
      const certificate = new X509Certificate(await readFile(config.tls.certificateFile));
      const key = await stat(config.tls.privateKeyFile);
      if ((key.mode & 0o077) !== 0) throw new Error('TLS private key permissions are too broad.');
      if (Date.parse(certificate.validTo) <= Date.now()) throw new Error('TLS certificate has expired.');
      if (!config.allowedOrigins.includes('weave://app') || !config.allowedOrigins.includes('capacitor://localhost')) throw new Error('Allow both weave://app and capacitor://localhost for desktop and iPad.');
      return `TLS certificate valid until ${certificate.validTo}; exact client origins allowed.`;
    }
    return 'Loopback-only listener; TLS is not configured.';
  });
  for (const agent of config.agents) await check('acp-provider', agent.agentId, async () => {
    if (!Bun.which(agent.command, { PATH: agent.env.PATH ?? process.env.PATH })) throw new Error('Provider executable is missing from its configured PATH.');
    const provider = new AgentProcess(agent, config.workspaces[0]?.path ?? config.stateDirectory, () => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([provider.request('initialize', { protocolVersion: 1, clientCapabilities: {} }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('ACP initialize timed out. Check provider installation and logs.')), 5000); })]);
      if (!response || typeof response !== 'object' || !('protocolVersion' in response)) throw new Error('Provider returned an invalid ACP initialize response.');
      return 'ACP initialize succeeded. Model credentials and prompt execution require a client prompt.';
    } finally { clearTimeout(timer); await provider.close(); }
  });
  const target = url ?? (!config.tls ? `http://127.0.0.1:${config.listen.port}` : undefined);
  await check('network', 'Host health endpoint', async () => {
    if (!target) throw new Error('Pass --url https://<certificate-hostname>:<port> to verify TLS and network reachability.');
    const endpoint = new URL('/health', target);
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Health URL must use HTTP(S).');
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
    const health = await response.json() as { status?: string; build?: unknown };
    if (!response.ok || health.status !== 'ok') throw new Error(`Host health failed: HTTP ${response.status}`);
    return `Reachable with transport trust verified; build ${JSON.stringify(health.build ?? 'legacy')}`;
  });
  return { build: hostVersion, checks };
}
