import { basename, resolve } from 'node:path';

export const defaultDeployRef = 'refs/heads/deploy/pi-dev';
export const defaultLastGoodRef = 'refs/heads/deploy/pi-last-good';

type CommandOptions = {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: 'inherit' | 'null';
  stdout?: 'inherit' | 'piped' | 'null';
  stderr?: 'inherit' | 'piped' | 'null';
};

type Snapshot = {
  commit: string;
  parent: string;
  files: string[];
};

export type DeploymentRecord = {
  deploymentId: string;
  title?: string;
  description?: string | null;
  status?: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  createdAt?: string;
  errorMessage?: string | null;
  logPath?: string | null;
};

export type DokployConfig = {
  baseUrl: string;
  composeId: string;
  token: string;
  timeoutMs: number;
  pollIntervalMs: number;
};

const textDecoder = new TextDecoder();
const repoRoot = resolve(import.meta.dirname ?? '.', '..');

const commandText = async (command: string, args: string[], options: CommandOptions = {}) => {
  const output = await new Deno.Command(command, {
    args,
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin ?? 'null',
    stdout: options.stdout ?? 'piped',
    stderr: options.stderr ?? 'piped',
  }).output();
  const stdout = options.stdout === 'inherit' || options.stdout === 'null' ? '' : textDecoder.decode(output.stdout);
  const stderr = options.stderr === 'inherit' || options.stderr === 'null' ? '' : textDecoder.decode(output.stderr);
  if (!output.success) {
    const details = stderr.trim() || stdout.trim() || `exit code ${output.code}`;
    throw new Error(`${basename(command)} ${args[0] ?? ''} failed: ${details}`);
  }
  return stdout.trim();
};

const git = (cwd: string, args: string[], env?: Record<string, string>) => commandText('git', args, { cwd, env });

const requiredEnv = (name: string) => {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required. Copy server/.env.deploy.example to server/.env.deploy.`);
  return value;
};

const optionalEnv = (name: string, fallback: string) => Deno.env.get(name)?.trim() || fallback;

export const loadDokployConfig = (): DokployConfig => ({
  baseUrl: requiredEnv('WEAVE_DOKPLOY_URL').replace(/\/+$/, ''),
  composeId: requiredEnv('WEAVE_DOKPLOY_COMPOSE_ID'),
  token: requiredEnv('WEAVE_DOKPLOY_API_TOKEN'),
  timeoutMs: Number(optionalEnv('WEAVE_DOKPLOY_TIMEOUT_MS', '900000')),
  pollIntervalMs: Number(optionalEnv('WEAVE_DOKPLOY_POLL_INTERVAL_MS', '2000')),
});

const remoteName = () => optionalEnv('WEAVE_DEPLOY_REMOTE', 'origin');
const deployRef = () => optionalEnv('WEAVE_DEPLOY_REF', defaultDeployRef);
const lastGoodRef = () => optionalEnv('WEAVE_LAST_GOOD_REF', defaultLastGoodRef);

const assertSafeGitRef = (ref: string) => {
  if (!/^refs\/heads\/[A-Za-z0-9._\/-]+$/.test(ref) || ref.includes('..') || ref.endsWith('/')) {
    throw new Error(`Unsafe deployment ref: ${ref}`);
  }
};

export const isSuspiciousSnapshotPath = (path: string) => {
  const name = basename(path).toLowerCase();
  if ((name === '.env' || name.startsWith('.env.')) && !name.endsWith('.example')) return true;
  if (/\.(pem|key|p12|pfx|keystore|jks)$/i.test(name)) return true;
  return /^(id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials|secrets?)$/i.test(name);
};

const splitNull = (value: string) => value.split('\0').filter(Boolean);

export const createServerSnapshot = async (cwd = repoRoot): Promise<Snapshot> => {
  const conflicts = await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
  if (conflicts) throw new Error(`Resolve merge conflicts before deploying:\n${conflicts}`);

  const indexPath = await Deno.makeTempFile({ prefix: 'weave-deploy-index-' });
  await Deno.remove(indexPath);
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    await git(cwd, ['read-tree', 'HEAD'], env);
    await git(cwd, ['add', '-A', '--', 'server', 'packages/protocol'], env);
    const listed = await git(cwd, ['diff', '--cached', '--name-only', '-z'], env);
    const files = splitNull(listed);
    const suspicious = files.filter(isSuspiciousSnapshotPath);
    if (suspicious.length) {
      throw new Error(`Refusing to snapshot possible secrets:\n${suspicious.map((path) => `- ${path}`).join('\n')}`);
    }

    const tree = await git(cwd, ['write-tree'], env);
    const parent = await git(cwd, ['rev-parse', 'HEAD']);
    const message = `Weave Pi snapshot ${new Date().toISOString()}`;
    const commit = await git(cwd, ['commit-tree', tree, '-p', parent, '-m', message]);
    return { commit, parent, files };
  } finally {
    await Deno.remove(indexPath).catch(() => undefined);
  }
};

export const getRemoteRef = async (cwd: string, remote: string, ref: string) => {
  assertSafeGitRef(ref);
  const output = await git(cwd, ['ls-remote', '--heads', remote, ref]);
  return output ? output.split(/\s+/)[0] : undefined;
};

export const pushRefAtLease = async (
  cwd: string,
  remote: string,
  commit: string,
  ref: string,
  expected: string | undefined,
) => {
  assertSafeGitRef(ref);
  const lease = `--force-with-lease=${ref}:${expected ?? ''}`;
  await git(cwd, ['push', remote, `${commit}:${ref}`, lease]);
};

export const pushSnapshot = async (snapshot: Snapshot, cwd = repoRoot) => {
  const remote = remoteName();
  const ref = deployRef();
  const expected = await getRemoteRef(cwd, remote, ref);
  await pushRefAtLease(cwd, remote, snapshot.commit, ref, expected);
  return { remote, ref, previous: expected };
};

const apiJson = async <T>(config: DokployConfig, path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${config.baseUrl}/api/${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-api-key': config.token,
      ...init?.headers,
    },
  });
  const body = await response.text();
  if (!response.ok) {
    const safeBody = config.token ? body.replaceAll(config.token, '[REDACTED]') : body;
    throw new Error(`Dokploy ${path} returned ${response.status}: ${safeBody.slice(0, 2000)}`);
  }
  if (!body) return undefined as T;
  return JSON.parse(body) as T;
};

export const listDeployments = (config: DokployConfig) =>
  apiJson<DeploymentRecord[]>(config, `deployment.allByCompose?composeId=${encodeURIComponent(config.composeId)}`);

const readDeploymentLogs = async (config: DokployConfig, deployment: DeploymentRecord) => {
  const response = await apiJson<unknown>(
    config,
    `deployment.readLogs?deploymentId=${encodeURIComponent(deployment.deploymentId)}&tail=500`,
  ).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object') {
    const record = response as Record<string, unknown>;
    if (typeof record.logs === 'string') return record.logs;
    if (typeof record.log === 'string') return record.log;
  }

  const target = Deno.env.get('WEAVE_DOKPLOY_SSH_TARGET')?.trim();
  const logPath = deployment.logPath?.trim();
  if (target && logPath && /^\/[A-Za-z0-9_./-]+$/.test(logPath)) {
    const sshLogs = await commandText('ssh', [target, 'tail', '-n', '500', '--', logPath]).catch((error) =>
      `SSH log read failed: ${error instanceof Error ? error.message : String(error)}`
    );
    if (sshLogs) return sshLogs;
  }
  return JSON.stringify(response, null, 2);
};

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

export const triggerAndWaitForDeployment = async (
  config: DokployConfig,
  title: string,
  description: string,
) => {
  const before = new Set((await listDeployments(config)).map((item) => item.deploymentId));
  await apiJson(config, 'compose.deploy', {
    method: 'POST',
    body: JSON.stringify({ composeId: config.composeId, title, description }),
  });

  const deadline = Date.now() + config.timeoutMs;
  let deployment: DeploymentRecord | undefined;
  while (Date.now() < deadline) {
    const deployments = await listDeployments(config);
    deployment = deployments.find((item) => item.title === title && !before.has(item.deploymentId)) ??
      deployments.find((item) => !before.has(item.deploymentId));
    if (!deployment || deployment.status === 'queued' || deployment.status === 'running' || !deployment.status) {
      await delay(config.pollIntervalMs);
      continue;
    }
    if (deployment.status === 'done') return deployment;

    const logs = await readDeploymentLogs(config, deployment);
    throw new Error(
      `Dokploy deployment ${deployment.status}: ${deployment.errorMessage ?? 'no error message'}\n${logs}`,
    );
  }
  throw new Error(`Timed out waiting for Dokploy deployment${deployment ? ` ${deployment.deploymentId}` : ''}.`);
};

const healthUrls = () => ({
  server: optionalEnv('WEAVE_REMOTE_SERVER_URL', 'http://homelab:4111').replace(/\/+$/, ''),
});

const fetchHealth = async (url: string) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const body = await response.json() as { ok?: unknown };
  if (body.ok !== true) throw new Error(`${url} did not return { ok: true }`);
};

export const verifyRemoteHealth = async (timeoutMs = 90000) => {
  const urls = healthUrls();
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await fetchHealth(`${urls.server}/health`);
      await verifyRemoteRpc(urls.server);
      return urls;
    } catch (error) {
      lastError = error;
      await delay(2000);
    }
  }
  throw new Error(`Remote health verification failed: ${lastError instanceof Error ? lastError.message : lastError}`);
};

export const verifyRemoteRpc = async (serverUrl: string) => {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/rpc`;
  url.search = '';
  const token = Deno.env.get('WEAVE_REMOTE_OWNER_TOKEN')?.trim() ?? Deno.env.get('WEAVE_OWNER_TOKEN')?.trim();
  if (!token) {
    throw new Error('WEAVE_REMOTE_OWNER_TOKEN is required for authenticated RPC deployment verification');
  }
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`${url} RPC probe timed out`));
    }, 5_000);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    socket.onopen = () => {
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'deploy-probe',
        method: 'initialize',
        params: {
          protocolVersion: 1,
          role: 'client',
          token,
          capabilities: [],
          client: {
            clientAppId: 'deploy-probe',
            clientInstanceId: `deploy-probe-${crypto.randomUUID()}`,
          },
        },
      }));
    };
    socket.onmessage = event => {
      try {
        const message = JSON.parse(String(event.data)) as { id?: unknown; result?: { protocolVersion?: unknown } };
        if (message.id !== 'deploy-probe' || message.result?.protocolVersion !== 1) {
          throw new Error('RPC probe received an invalid initialize response.');
        }
        socket.close(1000, 'Deployment RPC probe complete.');
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    socket.onerror = () => finish(new Error(`${url} WebSocket upgrade failed`));
    socket.onclose = event => {
      if (event.code !== 1000) finish(new Error(`${url} RPC probe closed (${event.code})`));
    };
  });
};

const promoteLastGood = async (commit: string, cwd = repoRoot) => {
  const remote = remoteName();
  const ref = lastGoodRef();
  const expected = await getRemoteRef(cwd, remote, ref);
  await pushRefAtLease(cwd, remote, commit, ref, expected);
};

const snapshotTitle = (prefix: string, commit: string) =>
  `${prefix} ${commit.slice(0, 12)} ${new Date().toISOString()}`;

const prepare = async () => {
  const snapshot = await createServerSnapshot();
  const pushed = await pushSnapshot(snapshot);
  console.info(`Pushed ${snapshot.commit} to ${pushed.remote}/${pushed.ref}.`);
  console.info(`Snapshot includes ${snapshot.files.length} changed server file(s).`);
  console.info(
    'Configure Dokploy for branch deploy/pi-dev with compose path server/compose.dokploy.yml and Auto Deploy off.',
  );
};

const deploy = async () => {
  const config = loadDokployConfig();
  const snapshot = await createServerSnapshot();
  await pushSnapshot(snapshot);
  const title = snapshotTitle('Weave snapshot', snapshot.commit);
  console.info(`Deploying ${snapshot.commit.slice(0, 12)} through Dokploy...`);
  const deployment = await triggerAndWaitForDeployment(config, title, `Source snapshot ${snapshot.commit}`);
  const urls = await verifyRemoteHealth();
  await promoteLastGood(snapshot.commit);
  console.info(`Deployment ${deployment.deploymentId} is healthy.`);
  console.info(`Server: ${urls.server}`);
};

const status = async () => {
  const config = loadDokployConfig();
  const remote = remoteName();
  const [current, lastGood, deployments] = await Promise.all([
    getRemoteRef(repoRoot, remote, deployRef()),
    getRemoteRef(repoRoot, remote, lastGoodRef()),
    listDeployments(config),
  ]);
  console.info(`Deploy ref: ${current ?? 'missing'}\nLast good: ${lastGood ?? 'missing'}`);
  const latest = deployments[0];
  console.info(
    `Dokploy: ${latest ? `${latest.status ?? 'unknown'} ${latest.title ?? latest.deploymentId}` : 'no deployments'}`,
  );
  try {
    const urls = await verifyRemoteHealth(5000);
    console.info(`Health: ok (${urls.server})`);
  } catch (error) {
    console.info(`Health: unavailable (${error instanceof Error ? error.message : error})`);
  }
};

const rollback = async () => {
  const config = loadDokployConfig();
  const remote = remoteName();
  const target = await getRemoteRef(repoRoot, remote, lastGoodRef());
  if (!target) throw new Error(`Remote ${lastGoodRef()} does not exist; no successful snapshot has been recorded.`);
  const expected = await getRemoteRef(repoRoot, remote, deployRef());
  await pushRefAtLease(repoRoot, remote, target, deployRef(), expected);
  const title = snapshotTitle('Weave rollback', target);
  await triggerAndWaitForDeployment(config, title, `Rollback application code to ${target}; database is unchanged.`);
  await verifyRemoteHealth();
  console.info(`Rolled application code back to ${target}. Database migrations were not rolled back.`);
};

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const sshText = (target: string, script: string) => commandText('ssh', [target, 'bash', '-lc', shellQuote(script)]);

const findRemoteContainer = async (target: string, appName: string, service: string, includeStopped = false) => {
  const command = `docker ps ${includeStopped ? '-aq' : '-q'} ` +
    `--filter label=com.docker.compose.project=${shellQuote(appName)} ` +
    `--filter label=com.docker.compose.service=${shellQuote(service)} | head -n 1`;
  const id = await sshText(target, command);
  if (!id) throw new Error(`Could not find remote ${service} container for Compose project ${appName}.`);
  return id;
};

const composeAppName = async (config: DokployConfig) => {
  const compose = await apiJson<Record<string, unknown>>(
    config,
    `compose.one?composeId=${encodeURIComponent(config.composeId)}`,
  );
  if (typeof compose.appName !== 'string' || !compose.appName) {
    throw new Error('Dokploy compose.one did not return appName.');
  }
  return compose.appName;
};

const localServerIsRunning = async () => {
  try {
    const response = await fetch('http://127.0.0.1:4111/health', { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
};

const postgresSchemaSummary = (container: string) =>
  commandText('docker', [
    'exec',
    container,
    'psql',
    '-U',
    'supabase_admin',
    '-d',
    'weave',
    '-Atc',
    "select schemaname || ':' || count(*) from pg_tables where schemaname in ('weave','mastra','dbos') group by schemaname order by schemaname;",
  ]);

const streamPostgresCutover = async (target: string, localPostgres: string, remotePostgres: string) => {
  const dump = new Deno.Command('docker', {
    args: [
      'exec',
      localPostgres,
      'pg_dump',
      '-U',
      'supabase_admin',
      '-d',
      'weave',
      '-Fc',
      '--no-owner',
      '--no-privileges',
      '--schema=weave',
      '--schema=mastra',
      '--schema=dbos',
    ],
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const restoreScript = `docker exec -i ${shellQuote(remotePostgres)} pg_restore -U supabase_admin -d weave ` +
    '--clean --if-exists --no-owner --no-privileges --exit-on-error';
  const restore = new Deno.Command('ssh', {
    args: [target, 'bash', '-lc', shellQuote(restoreScript)],
    stdin: 'piped',
    stdout: 'inherit',
    stderr: 'inherit',
  }).spawn();
  const piping = dump.stdout.pipeTo(restore.stdin);
  const dumpStderr = new Response(dump.stderr).text();
  const [dumpStatus, restoreStatus, , dumpError] = await Promise.all([
    dump.status,
    restore.status,
    piping,
    dumpStderr,
  ]);
  if (!dumpStatus.success) {
    throw new Error(`pg_dump failed: ${dumpError}`);
  }
  if (!restoreStatus.success) throw new Error(`Remote pg_restore failed with exit code ${restoreStatus.code}.`);
};

const runObjectCopy = async () => {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      'run',
      '--config',
      'server/deno.json',
      '--allow-env',
      '--allow-net',
      '--allow-sys',
      'server/src/storage/copy-object-store.ts',
    ],
    cwd: repoRoot,
    stdin: 'null',
    stdout: 'inherit',
    stderr: 'inherit',
  }).output();
  if (!output.success) throw new Error(`Garage object copy failed with exit code ${output.code}.`);
};

const cutover = async () => {
  const config = loadDokployConfig();
  const target = requiredEnv('WEAVE_DOKPLOY_SSH_TARGET');
  const localPostgres = optionalEnv('WEAVE_LOCAL_POSTGRES_CONTAINER', 'weave-dbos-postgres');
  if (await localServerIsRunning()) {
    throw new Error('Stop the local Weave server on port 4111 before starting cutover.');
  }

  const confirmation = prompt(
    'Type MIGRATE WEAVE TO HOMELAB to replace the Pi database and stop local infrastructure:',
  );
  if (confirmation !== 'MIGRATE WEAVE TO HOMELAB') throw new Error('Cutover cancelled.');

  await commandText('docker', ['inspect', localPostgres]);
  const appName = await composeAppName(config);
  const remotePostgres = await findRemoteContainer(target, appName, 'postgres');
  const remoteServer = await findRemoteContainer(target, appName, 'weave-server');
  const remoteMigrate = await findRemoteContainer(target, appName, 'weave-migrate', true);
  const localSummary = await postgresSchemaSummary(localPostgres);

  console.info(`Stopping remote server ${remoteServer.slice(0, 12)} and streaming Postgres schemas...`);
  await sshText(target, `docker stop ${shellQuote(remoteServer)}`);
  try {
    await streamPostgresCutover(target, localPostgres, remotePostgres);
    await runObjectCopy();
    await sshText(target, `docker start -a ${shellQuote(remoteMigrate)}`);
    await sshText(target, `docker start ${shellQuote(remoteServer)}`);
  } catch (error) {
    await sshText(target, `docker start ${shellQuote(remoteServer)}`).catch(() => undefined);
    throw error;
  }

  const remoteSummary = await sshText(
    target,
    `docker exec ${shellQuote(remotePostgres)} psql -U supabase_admin -d weave -Atc ` +
      shellQuote(
        "select schemaname || ':' || count(*) from pg_tables where schemaname in ('weave','mastra','dbos') group by schemaname order by schemaname;",
      ),
  );
  if (remoteSummary !== localSummary) {
    throw new Error(`Postgres schema summary mismatch.\nLocal:\n${localSummary}\nRemote:\n${remoteSummary}`);
  }
  await verifyRemoteHealth();
  console.info('Remote data and health checks passed.');
  console.info(
    'Set Desktop to http://homelab:4111 with the Dokploy owner token, then test terminal and file operations.',
  );
  const localStopConfirmation = prompt(
    'After Desktop and Portal work end-to-end, type STOP LOCAL INFRASTRUCTURE to stop local Compose services:',
  );
  if (localStopConfirmation !== 'STOP LOCAL INFRASTRUCTURE') {
    console.info(
      'Remote cutover is healthy. Local infrastructure remains running and all local volumes are preserved.',
    );
    console.info('Run `deno task infra:down` only after Desktop and Portal have been verified.');
    return;
  }
  await commandText(Deno.execPath(), ['task', 'infra:down'], { cwd: repoRoot, stdout: 'inherit', stderr: 'inherit' });
  console.info('Cutover verified. Local infrastructure is stopped; its volumes were preserved.');
};

export const main = async (args = Deno.args) => {
  switch (args[0]) {
    case 'prepare':
      return await prepare();
    case 'deploy':
      return await deploy();
    case 'status':
      return await status();
    case 'rollback':
      return await rollback();
    case 'cutover':
      return await cutover();
    default:
      throw new Error('Usage: dokploy-server.ts <prepare|deploy|status|rollback|cutover>');
  }
};

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    Deno.exit(1);
  });
}
