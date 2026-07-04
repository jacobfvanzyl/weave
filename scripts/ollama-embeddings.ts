const DEFAULT_CONTAINER = 'weave-ollama-embeddings';
const DEFAULT_VOLUME = 'weave-ollama';
const DEFAULT_PORT = '11434';
const DEFAULT_IMAGE = 'ollama/ollama:latest';
const DEFAULT_MODEL = 'nomic-embed-text';

type Action = 'start' | 'stop' | 'status' | 'logs';

type DockerResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type ContainerInfo = {
  running: boolean;
  image?: string;
  status?: string;
};

const decoder = new TextDecoder();

const usage = () => {
  console.log(`Usage: deno task ollama:embeddings[:start|:stop|:status|:logs]

Environment overrides:
  WEAVE_OLLAMA_CONTAINER   Container name (default: ${DEFAULT_CONTAINER})
  WEAVE_OLLAMA_VOLUME      Docker volume name (default: ${DEFAULT_VOLUME})
  WEAVE_OLLAMA_PORT        Host port bound to 127.0.0.1 (default: ${DEFAULT_PORT})
  WEAVE_OLLAMA_IMAGE       Ollama Docker image (default: ${DEFAULT_IMAGE})
  WEAVE_OLLAMA_MODEL       Embedding model to pull/check (default: ${DEFAULT_MODEL})
  WEAVE_OLLAMA_PLATFORM    Optional Docker platform, for example linux/arm64
`);
};

const env = (name: string, fallback: string) => {
  const value = Deno.env.get(name)?.trim();
  return value ? value : fallback;
};

const containerName = env('WEAVE_OLLAMA_CONTAINER', DEFAULT_CONTAINER);
const volumeName = env('WEAVE_OLLAMA_VOLUME', DEFAULT_VOLUME);
const hostPort = env('WEAVE_OLLAMA_PORT', DEFAULT_PORT);
const image = env('WEAVE_OLLAMA_IMAGE', DEFAULT_IMAGE);
const model = env('WEAVE_OLLAMA_MODEL', DEFAULT_MODEL);
const baseUrl = `http://127.0.0.1:${hostPort}`;

const action = (Deno.args[0] ?? 'start') as Action | 'help' | '--help' | '-h';

if (action === 'help' || action === '--help' || action === '-h') {
  usage();
  Deno.exit(0);
}

if (!['start', 'stop', 'status', 'logs'].includes(action)) {
  console.error(`Unknown action: ${action}`);
  usage();
  Deno.exit(2);
}

async function runDocker(
  args: string[],
  options: { allowFailure?: boolean; inherit?: boolean } = {},
): Promise<DockerResult> {
  if (options.inherit) {
    const child = new Deno.Command('docker', {
      args,
      stdin: 'null',
      stdout: 'inherit',
      stderr: 'inherit',
    }).spawn();
    const status = await child.status;
    if (!status.success && !options.allowFailure) {
      throw new Error(
        `docker ${args.join(' ')} failed with code ${status.code}`,
      );
    }
    return { code: status.code, stdout: '', stderr: '' };
  }

  const output = await new Deno.Command('docker', {
    args,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).output();

  const result = {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };

  if (!output.success && !options.allowFailure) {
    const details = [result.stderr.trim(), result.stdout.trim()].filter(Boolean)
      .join('\n');
    throw new Error(
      `docker ${args.join(' ')} failed with code ${output.code}${details ? `\n${details}` : ''}`,
    );
  }

  return result;
}

async function ensureDockerAvailable() {
  const result = await runDocker(['info'], { allowFailure: true });
  if (result.code === 0) return;

  const details = [result.stderr.trim(), result.stdout.trim()].filter(Boolean)
    .join('\n');
  throw new Error(
    `Docker is not available. Start Docker and retry.${details ? `\n${details}` : ''}`,
  );
}

async function dockerServerPlatform() {
  const explicit = Deno.env.get('WEAVE_OLLAMA_PLATFORM')?.trim();
  if (explicit) return explicit;

  const result = await runDocker([
    'version',
    '--format',
    '{{.Server.Arch}} {{.Server.Os}}',
  ], {
    allowFailure: true,
  });
  const [arch, os] = result.stdout.trim().split(/\s+/);

  if (result.code === 0 && os && arch) {
    if (arch === 'arm64' || arch === 'aarch64') return `${os}/arm64`;
    if (arch === 'amd64' || arch === 'x86_64') return `${os}/amd64`;
  }

  const hostArch = Deno.build.arch;
  if (hostArch === 'aarch64') return 'linux/arm64';
  if (hostArch === 'x86_64') return 'linux/amd64';
  return undefined;
}

async function inspectContainer(name: string): Promise<ContainerInfo | null> {
  const result = await runDocker(['container', 'inspect', name], {
    allowFailure: true,
  });
  if (result.code !== 0) return null;

  const parsed = JSON.parse(result.stdout) as Array<{
    Config?: { Image?: string };
    State?: { Running?: boolean; Status?: string };
  }>;
  const info = parsed[0];
  return {
    running: info?.State?.Running === true,
    image: info?.Config?.Image,
    status: info?.State?.Status,
  };
}

async function waitForOllama() {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/tags`);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Ollama did not become ready at ${baseUrl}: ${lastError}`);
}

async function startContainer(platform: string | undefined) {
  const existing = await inspectContainer(containerName);
  if (!existing) {
    const args = [
      'run',
      '-d',
      '--restart',
      'unless-stopped',
      '-v',
      `${volumeName}:/root/.ollama`,
      '-p',
      `127.0.0.1:${hostPort}:11434`,
      '--name',
      containerName,
    ];

    if (platform) args.push('--platform', platform);
    args.push(image);

    console.log(
      `Creating ${containerName} from ${image} on ${baseUrl}${platform ? ` (${platform})` : ''}`,
    );
    await runDocker(args, { inherit: true });
    return;
  }

  if (!existing.running) {
    console.log(
      `Starting existing ${containerName} (${existing.status ?? 'stopped'})`,
    );
    await runDocker(['start', containerName], { inherit: true });
    return;
  }

  console.log(`${containerName} is already running on ${baseUrl}`);
}

async function pullModel() {
  console.log(`Ensuring Ollama model is available: ${model}`);
  await runDocker(['exec', containerName, 'ollama', 'pull', model], {
    inherit: true,
  });
}

async function verifyEmbedding() {
  const input = 'weave semantic recall health check';
  const response = await fetch(`${baseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `/api/embed failed with HTTP ${response.status}${text ? `\n${text}` : ''}`,
    );
  }

  const payload = await response.json() as { embeddings?: unknown };
  const embeddings = payload.embeddings;
  const firstEmbedding = Array.isArray(embeddings) && Array.isArray(embeddings[0]) ? embeddings[0] as unknown[] : null;

  if (!firstEmbedding) {
    throw new Error(`/api/embed did not return embeddings for ${model}`);
  }

  console.log(
    `${model} is ready at ${baseUrl} (${firstEmbedding.length} dimensions)`,
  );
}

async function printStatus() {
  const info = await inspectContainer(containerName);
  if (!info) {
    console.log(`${containerName} does not exist`);
    return;
  }

  console.log(
    `${containerName}: ${info.status ?? 'unknown'} (${info.image ?? image})`,
  );
  if (!info.running) return;

  try {
    await waitForOllama();
    console.log(`Ollama API: ${baseUrl}`);
    await runDocker(['exec', containerName, 'ollama', 'list'], {
      inherit: true,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exitCode = 1;
  }
}

async function stopContainer() {
  const info = await inspectContainer(containerName);
  if (!info) {
    console.log(`${containerName} does not exist`);
    return;
  }
  if (!info.running) {
    console.log(`${containerName} is already stopped`);
    return;
  }

  await runDocker(['stop', containerName], { inherit: true });
}

async function followLogs() {
  await runDocker(['logs', '-f', containerName], { inherit: true });
}

await ensureDockerAvailable();
const resolvedPlatform = await dockerServerPlatform();

if (action === 'start') {
  await startContainer(resolvedPlatform);
  await waitForOllama();
  await pullModel();
  await verifyEmbedding();
} else if (action === 'stop') {
  await stopContainer();
} else if (action === 'status') {
  await printStatus();
} else if (action === 'logs') {
  await followLogs();
}
