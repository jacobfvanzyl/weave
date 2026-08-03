import { type ChildProcess, spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import {
  RpcConnection,
  WEAVE_RPC_BINARY_CHUNK_BYTES,
  WEAVE_RPC_BINARY_WINDOW_SIZE,
  WEAVE_RPC_PROTOCOL_VERSION,
} from "@weave/protocol";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = path.resolve(desktopRoot, "..");
const serverConfigPath = path.join(repositoryRoot, "server", "deno.json");
const portalConfigPath = path.join(repositoryRoot, "portal", "deno.json");
const portalSourcePath = path.join(repositoryRoot, "portal", "src", "main.ts");
const desktopMainPath = path.join(desktopRoot, ".vite", "build", "main.js");
const postgresImage = process.env.WEAVE_ACCEPTANCE_POSTGRES_IMAGE ??
  "supabase/postgres:17.6.1.142";
const timeoutMs = 60_000;

type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  label: string;
};

type RunningProcess = {
  child: ChildProcess;
  label: string;
  output: () => string;
};

const randomValue = () => crypto.randomUUID().replaceAll("-", "");
const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const command = (
  executable: string,
  args: string[],
  options: CommandOptions,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output.trim());
      else {reject(
          new Error(
            `${options.label} failed (${
              signal ?? code ?? "unknown"
            }).\n${output.trim()}`,
          ),
        );}
    });
  });

const startProcess = (
  executable: string,
  args: string[],
  options: CommandOptions,
): RunningProcess => {
  const child = spawn(executable, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let captured = "";
  const capture = (chunk: unknown) => {
    captured = `${captured}${String(chunk)}`.slice(-16_000);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return { child, label: options.label, output: () => captured };
};

const stopProcess = async (process: RunningProcess | undefined) => {
  if (!process || process.child.exitCode !== null) return;
  process.child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<true>((resolve) =>
      process.child.once("exit", () => resolve(true))
    ),
    delay(5_000).then(() => false as const),
  ]);
  if (!exited && process.child.exitCode === null) {
    process.child.kill("SIGKILL");
    await new Promise<void>((resolve) =>
      process.child.once("exit", () => resolve())
    );
  }
};

const waitFor = async (
  description: string,
  check: () => Promise<boolean>,
  runningProcess?: RunningProcess,
) => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (runningProcess && runningProcess.child.exitCode !== null) {
      throw new Error(
        `${runningProcess.label} exited before ${description}.\n${runningProcess.output()}`,
      );
    }
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for ${description}.${
      lastError ? ` ${String(lastError)}` : ""
    }${runningProcess ? `\n${runningProcess.output()}` : ""}`,
  );
};

const reservePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a server port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

type DockerAccess = {
  host: string;
  sshTarget?: string;
  sshPort?: string;
};

const dockerAccessForContext = async (
  context: string,
): Promise<DockerAccess> => {
  const explicit = process.env.WEAVE_ACCEPTANCE_DOCKER_HOST?.trim();
  if (explicit) return { host: explicit };
  const endpoint = await command(
    "docker",
    ["context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"],
    { label: "Docker context inspection" },
  );
  if (!endpoint.startsWith("ssh://")) return { host: "127.0.0.1" };
  const url = new URL(endpoint);
  return {
    host: "127.0.0.1",
    sshTarget: `${
      url.username ? `${decodeURIComponent(url.username)}@` : ""
    }${url.hostname}`,
    sshPort: url.port || undefined,
  };
};

const canConnect = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (connected: boolean) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });

const sqlLiteral = (value: string | number) =>
  typeof value === "number"
    ? String(value)
    : `'${value.replaceAll("'", "''")}'`;

class AcceptanceDatabase {
  constructor(
    private readonly dockerContext: string,
    private readonly containerName: string,
  ) {}

  async scalar(sql: string, values: Array<string | number> = []) {
    const statement = values.reduceRight<string>(
      (current, value, index) =>
        current.replaceAll(`$${index + 1}`, sqlLiteral(value)),
      sql,
    );
    return await command(
      "docker",
      [
        "--context",
        this.dockerContext,
        "exec",
        this.containerName,
        "psql",
        "--username",
        "supabase_admin",
        "--dbname",
        "weave_acceptance",
        "--tuples-only",
        "--no-align",
        "--command",
        statement,
      ],
      { label: "Acceptance database assertion" },
    );
  }
}

export type AcceptanceDesktopClient = {
  app: ElectronApplication;
  page: Page;
  waitUntilConnected: () => Promise<void>;
};

export type AcceptancePortal = {
  portalId: string;
};

export class FullStackAcceptanceHarness {
  readonly ownerId = `acceptance-owner-${randomValue()}`;
  readonly database: AcceptanceDatabase;
  readonly rpc: RpcConnection;
  readonly workspacePath: string;

  private serverProcess: RunningProcess | undefined;
  private portalProcess: RunningProcess | undefined;
  private databaseTunnel: RunningProcess | undefined;
  private readonly desktopClients: AcceptanceDesktopClient[] = [];

  private constructor(
    private readonly rootPath: string,
    workspacePath: string,
    private readonly dockerContext: string,
    private readonly postgresContainerName: string,
    private databaseUrl: string,
    private readonly serverUrl: string,
    private readonly ownerToken: string,
    private readonly credentialEncryptionKey: string,
    private readonly portalHomePath: string,
  ) {
    this.workspacePath = workspacePath;
    this.database = new AcceptanceDatabase(
      dockerContext,
      postgresContainerName,
    );
    this.rpc = new RpcConnection({
      serverUrl,
      reconnect: true,
      reconnectDelayMs: () => 100,
      initialize: {
        protocolVersion: WEAVE_RPC_PROTOCOL_VERSION,
        role: "client",
        token: ownerToken,
        capabilities: [],
        client: {
          clientAppId: "weave-acceptance-control",
          clientInstanceId: `acceptance-control-${randomValue()}`,
        },
      },
    });
  }

  static async start() {
    await access(desktopMainPath).catch(() => {
      throw new Error(
        "Desktop production bundle is missing. Run `bun --filter weave-desktop package` first.",
      );
    });
    const rootPath = await mkdtemp(path.join(tmpdir(), "weave-acceptance-"));
    const workspacePath = path.join(rootPath, "workspace");
    const portalHomePath = path.join(rootPath, "portal");
    await command("git", ["init", "--initial-branch=main", workspacePath], {
      label: "Acceptance Workspace creation",
    });
    await writeFile(
      path.join(workspacePath, "README.md"),
      "# Acceptance Workspace\n",
    );
    await command("git", ["-C", workspacePath, "add", "README.md"], {
      label: "Acceptance Workspace staging",
    });
    await command(
      "git",
      [
        "-C",
        workspacePath,
        "-c",
        "user.name=Weave Acceptance",
        "-c",
        "user.email=acceptance@invalid.test",
        "commit",
        "-m",
        "Acceptance fixture",
      ],
      { label: "Acceptance Workspace commit" },
    );

    const dockerContext = process.env.WEAVE_ACCEPTANCE_DOCKER_CONTEXT?.trim() ||
      (await command("docker", ["context", "show"], {
        label: "Docker context selection",
      }));
    const dockerAccess = await dockerAccessForContext(dockerContext);
    const suffix = randomValue().slice(0, 12);
    const postgresContainerName = `weave-acceptance-${suffix}`;
    const postgresPassword = randomValue();
    const ownerToken = randomValue();
    const credentialEncryptionKey = Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("base64");
    const serverPort = await reservePort();
    const serverUrl = `http://127.0.0.1:${serverPort}`;

    const harness = new FullStackAcceptanceHarness(
      rootPath,
      workspacePath,
      dockerContext,
      postgresContainerName,
      "",
      serverUrl,
      ownerToken,
      credentialEncryptionKey,
      portalHomePath,
    );
    try {
      await command(
        "docker",
        [
          "--context",
          dockerContext,
          "run",
          "--detach",
          "--rm",
          "--name",
          postgresContainerName,
          "--label",
          "dev.weave.acceptance=true",
          "--env",
          `POSTGRES_DB=weave_acceptance`,
          "--env",
          `POSTGRES_PASSWORD=${postgresPassword}`,
          "--publish",
          "0:5432",
          "--health-cmd",
          "pg_isready -U postgres -d weave_acceptance",
          "--health-interval",
          "1s",
          "--health-timeout",
          "5s",
          "--health-retries",
          "30",
          postgresImage,
        ],
        { label: "Acceptance PostgreSQL startup" },
      );
      let healthySince = 0;
      await waitFor("stable Acceptance PostgreSQL health", async () => {
        const healthy = (await command(
          "docker",
          [
            "--context",
            dockerContext,
            "inspect",
            "--format",
            "{{.State.Health.Status}}",
            postgresContainerName,
          ],
          { label: "Acceptance PostgreSQL health check" },
        )) === "healthy";
        if (!healthy) {
          healthySince = 0;
          return false;
        }
        healthySince ||= Date.now();
        return Date.now() - healthySince >= 2_000;
      });
      const publishedPort = await command(
        "docker",
        ["--context", dockerContext, "port", postgresContainerName, "5432/tcp"],
        { label: "Acceptance PostgreSQL port discovery" },
      );
      const postgresPort = Number(publishedPort.trim().split(":").at(-1));
      if (!Number.isInteger(postgresPort)) {
        throw new Error(
          "Docker did not publish an Acceptance PostgreSQL port.",
        );
      }
      const reachablePort = dockerAccess.sshTarget
        ? await harness.startDatabaseTunnel(
          dockerAccess.sshTarget,
          dockerAccess.sshPort,
          postgresPort,
        )
        : postgresPort;
      harness.databaseUrl =
        `postgresql://supabase_admin:${postgresPassword}@${dockerAccess.host}:${reachablePort}/weave_acceptance`;
      await harness.migrateDatabase();
      await harness.startServer();
      await harness.rpc.connect();
      return harness;
    } catch (error) {
      await harness.stop();
      throw error;
    }
  }

  async startPortal(): Promise<AcceptancePortal> {
    await command(
      "deno",
      [
        "run",
        "--config",
        portalConfigPath,
        "--allow-net",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        portalSourcePath,
        "login",
        "--server",
        this.serverUrl,
        "--token",
        this.ownerToken,
        "--name",
        "Acceptance Portal",
      ],
      {
        env: { ...process.env, WEAVE_PORTAL_HOME: this.portalHomePath },
        label: "Acceptance Portal login",
      },
    );
    await command(
      "deno",
      [
        "run",
        "--config",
        portalConfigPath,
        "--allow-net",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        portalSourcePath,
        "root",
        "--id",
        "default",
        "--name",
        "Acceptance Workspace",
        "--path",
        this.workspacePath,
      ],
      {
        env: { ...process.env, WEAVE_PORTAL_HOME: this.portalHomePath },
        label: "Acceptance Portal root configuration",
      },
    );
    this.portalProcess = startProcess(
      "deno",
      ["task", "--config", portalConfigPath, "daemon"],
      {
        env: { ...process.env, WEAVE_PORTAL_HOME: this.portalHomePath },
        label: "Acceptance Portal",
      },
    );
    let portalId = "";
    await waitFor(
      "Acceptance Portal connection",
      async () => {
        const { portals } = await this.rpc.request("portal.list");
        const portal = portals.find((candidate) =>
          candidate.name === "Acceptance Portal" &&
          candidate.status === "online"
        );
        portalId = portal?.portalId ?? "";
        return Boolean(portalId);
      },
      this.portalProcess,
    );
    return { portalId };
  }

  async launchDesktopClient(name: string): Promise<AcceptanceDesktopClient> {
    const userDataPath = path.join(this.rootPath, `desktop-${name}`);
    const app = await electron.launch({
      args: [desktopMainPath],
      env: {
        ...process.env,
        WEAVE_DESKTOP_SERVER_URL: this.serverUrl,
        WEAVE_DESKTOP_USER_DATA: userDataPath,
        WEAVE_DESKTOP_CONNECTION_USER_DATA: userDataPath,
        WEAVE_PORTAL_HOME: this.portalHomePath,
        WEAVE_OWNER_TOKEN: this.ownerToken,
      },
    });
    const page = await app.firstWindow();
    const waitUntilConnected = async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator("[data-weave-thread-sidebar]").waitFor({
        state: "visible",
        timeout: 15_000,
      });
    };
    await waitUntilConnected();
    const client = { app, page, waitUntilConnected };
    this.desktopClients.push(client);
    return client;
  }

  async writeWorkspaceFile(
    target: { projectId: string; workspaceId: string; workspacePath: string },
    filePath: string,
    content: string,
  ) {
    const bytes = new TextEncoder().encode(content);
    const digestBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes),
    );
    const sha256 = [...digestBytes].map((value) =>
      value.toString(16).padStart(2, "0")
    ).join("");
    const transferId = `acceptance-upload-${randomValue()}`;
    const chunks = Math.ceil(bytes.byteLength / WEAVE_RPC_BINARY_CHUNK_BYTES);
    await this.rpc.request("binary.begin", {
      transferId,
      direction: "upload",
      purpose: "workspaceFile.write",
      sizeBytes: bytes.byteLength,
      sha256,
      mimeType: "text/plain; charset=utf-8",
      chunkBytes: WEAVE_RPC_BINARY_CHUNK_BYTES,
      windowSize: WEAVE_RPC_BINARY_WINDOW_SIZE,
    });
    try {
      for (let index = 0; index < chunks; index += 1) {
        const start = index * WEAVE_RPC_BINARY_CHUNK_BYTES;
        await this.rpc.request("binary.chunk", {
          transferId,
          index,
          data: Buffer.from(
            bytes.subarray(start, start + WEAVE_RPC_BINARY_CHUNK_BYTES),
          ).toString("base64"),
        });
      }
      await this.rpc.request("binary.complete", { transferId, chunks, sha256 });
      return await this.rpc.request("workspaceFile.write", {
        target,
        path: filePath,
        transferId,
      });
    } catch (error) {
      await this.rpc.request("binary.abort", {
        transferId,
        reason: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      throw error;
    }
  }

  async restartServer() {
    await stopProcess(this.serverProcess);
    this.serverProcess = undefined;
    await this.startServer();
    await waitFor(
      "Acceptance control RPC reconnection",
      async () => this.rpc.state === "connected",
    );
  }

  async stop() {
    this.rpc.close();
    await Promise.allSettled(
      this.desktopClients.splice(0).map((client) => client.app.close()),
    );
    await stopProcess(this.portalProcess);
    await stopProcess(this.serverProcess);
    await stopProcess(this.databaseTunnel);
    await command(
      "docker",
      [
        "--context",
        this.dockerContext,
        "rm",
        "--force",
        this.postgresContainerName,
      ],
      { label: "Acceptance PostgreSQL cleanup" },
    ).catch(() => undefined);
    await rm(this.rootPath, { recursive: true, force: true });
  }

  private serverEnvironment() {
    return {
      ...process.env,
      PORT: new URL(this.serverUrl).port,
      WEAVE_DATABASE_URL: this.databaseUrl,
      WEAVE_DBOS_ENABLED: "0",
      WEAVE_MEMORY_EMBEDDING_MODEL: "openai/text-embedding-3-small",
      WEAVE_SEMANTIC_RECALL: "false",
      WEAVE_OWNER_TOKEN: this.ownerToken,
      WEAVE_OWNER_ID: this.ownerId,
      WEAVE_OWNER_NAME: "Weave Acceptance",
      WEAVE_CREDENTIAL_ENCRYPTION_KEY: this.credentialEncryptionKey,
    };
  }

  private async migrateDatabase() {
    await command(
      "deno",
      ["task", "--config", serverConfigPath, "db:migrate"],
      {
        env: this.serverEnvironment(),
        label: "Acceptance database migration",
      },
    );
  }

  private async startDatabaseTunnel(
    sshTarget: string,
    sshPort: string | undefined,
    remotePort: number,
  ) {
    const localPort = await reservePort();
    this.databaseTunnel = startProcess(
      "ssh",
      [
        "-N",
        "-o",
        "BatchMode=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        ...(sshPort ? ["-p", sshPort] : []),
        "-L",
        `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
        sshTarget,
      ],
      { label: "Acceptance PostgreSQL SSH tunnel" },
    );
    await waitFor(
      "Acceptance PostgreSQL SSH tunnel",
      () => canConnect("127.0.0.1", localPort),
      this.databaseTunnel,
    );
    return localPort;
  }

  private async startServer() {
    this.serverProcess = startProcess("deno", [
      "task",
      "--config",
      serverConfigPath,
      "start",
    ], {
      env: this.serverEnvironment(),
      label: "Acceptance server",
    });
    await waitFor(
      "Acceptance server health",
      async () => {
        const response = await fetch(`${this.serverUrl}/health`);
        return response.ok;
      },
      this.serverProcess,
    );
  }
}
