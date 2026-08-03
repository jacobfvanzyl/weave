import {
  createServerSnapshot,
  type DokployConfig,
  isSuspiciousSnapshotPath,
  pushRefAtLease,
  serverSnapshotPaths,
  triggerAndWaitForDeployment,
} from "./dokploy-server.ts";

const decoder = new TextDecoder();

const assertEquals = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
};

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const run = async (cwd: string, command: string, args: string[]) => {
  const output = await new Deno.Command(command, {
    cwd,
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = decoder.decode(output.stdout).trim();
  if (!output.success) {
    throw new Error(
      `${command} failed: ${decoder.decode(output.stderr) || stdout}`,
    );
  }
  return stdout;
};

const git = (cwd: string, ...args: string[]) => run(cwd, "git", args);

const createRepo = async () => {
  const root = await Deno.makeTempDir({ prefix: "weave-deploy-test-" });
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "Deploy Test");
  await git(root, "config", "user.email", "deploy@example.test");
  await Deno.mkdir(`${root}/server`, { recursive: true });
  await Deno.mkdir(`${root}/desktop`, { recursive: true });
  await Deno.mkdir(`${root}/mobile`, { recursive: true });
  await Deno.mkdir(`${root}/web`, { recursive: true });
  await Deno.mkdir(`${root}/packages/client`, { recursive: true });
  await Deno.mkdir(`${root}/packages/protocol`, { recursive: true });
  await Deno.mkdir(`${root}/scripts`, { recursive: true });
  await Deno.writeTextFile(`${root}/.dockerignore`, ".git\n");
  await Deno.writeTextFile(`${root}/bun.lock`, "{}\n");
  await Deno.writeTextFile(`${root}/bunfig.toml`, "[install]\n");
  await Deno.writeTextFile(`${root}/package.json`, "{}\n");
  await Deno.writeTextFile(`${root}/scripts/ensure-bun.mjs`, "export {};\n");
  await Deno.writeTextFile(
    `${root}/server/app.ts`,
    "export const value = 1;\n",
  );
  await Deno.writeTextFile(`${root}/desktop/package.json`, "{}\n");
  await Deno.writeTextFile(`${root}/mobile/package.json`, "{}\n");
  await Deno.writeTextFile(`${root}/web/package.json`, "{}\n");
  await Deno.writeTextFile(`${root}/packages/client/package.json`, "{}\n");
  await Deno.writeTextFile(
    `${root}/packages/protocol/index.ts`,
    "export const version = 1;\n",
  );
  await Deno.writeTextFile(`${root}/README.md`, "base\n");
  await Deno.writeTextFile(`${root}/.gitignore`, ".env\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "initial");
  return root;
};

Deno.test("server snapshots include dirty server files without touching branch or index", async () => {
  const root = await createRepo();
  try {
    await Deno.writeTextFile(
      `${root}/server/app.ts`,
      "export const value = 2;\n",
    );
    await Deno.writeTextFile(
      `${root}/server/new.ts`,
      "export const added = true;\n",
    );
    await Deno.writeTextFile(
      `${root}/packages/protocol/index.ts`,
      "export const version = 2;\n",
    );
    await Deno.writeTextFile(
      `${root}/packages/protocol/schema.ts`,
      "export const schema = true;\n",
    );
    await Deno.writeTextFile(
      `${root}/bunfig.toml`,
      '[install]\nlinker = "isolated"\n',
    );
    await Deno.writeTextFile(
      `${root}/scripts/ensure-bun.mjs`,
      "export const bun = true;\n",
    );
    await Deno.writeTextFile(`${root}/README.md`, "outside change\n");
    await Deno.writeTextFile(`${root}/server/.env`, "SECRET=ignored\n");
    const beforeStatus = await git(root, "status", "--porcelain=v1");
    const beforeBranch = await git(root, "branch", "--show-current");

    const snapshot = await createServerSnapshot(root);

    assertEquals(
      await git(root, "show", `${snapshot.commit}:server/app.ts`),
      "export const value = 2;",
    );
    assertEquals(
      await git(root, "show", `${snapshot.commit}:server/new.ts`),
      "export const added = true;",
    );
    assertEquals(
      await git(root, "show", `${snapshot.commit}:packages/protocol/index.ts`),
      "export const version = 2;",
    );
    assertEquals(
      await git(root, "show", `${snapshot.commit}:packages/protocol/schema.ts`),
      "export const schema = true;",
    );
    assertEquals(
      await git(root, "show", `${snapshot.commit}:bunfig.toml`),
      '[install]\nlinker = "isolated"',
    );
    assertEquals(
      await git(root, "show", `${snapshot.commit}:scripts/ensure-bun.mjs`),
      "export const bun = true;",
    );
    assertEquals(
      await git(root, "show", `${snapshot.commit}:README.md`),
      "base",
    );
    assertEquals(await git(root, "status", "--porcelain=v1"), beforeStatus);
    assertEquals(await git(root, "branch", "--show-current"), beforeBranch);
    assert(
      snapshot.files.includes("server/app.ts"),
      "tracked server change was omitted",
    );
    assert(
      snapshot.files.includes("server/new.ts"),
      "untracked server file was omitted",
    );
    assert(
      snapshot.files.includes("packages/protocol/index.ts"),
      "tracked protocol change was omitted",
    );
    assert(
      snapshot.files.includes("packages/protocol/schema.ts"),
      "untracked protocol file was omitted",
    );
    assert(
      snapshot.files.includes("bunfig.toml"),
      "root Bun configuration was omitted",
    );
    assert(
      snapshot.files.includes("scripts/ensure-bun.mjs"),
      "root Bun guard was omitted",
    );
    assert(
      !snapshot.files.includes("server/.env"),
      "ignored env file entered snapshot",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("server snapshot paths cover every Dockerfile build input", () => {
  assertEquals(serverSnapshotPaths, [
    ".dockerignore",
    "bun.lock",
    "bunfig.toml",
    "package.json",
    "scripts/ensure-bun.mjs",
    "server",
    "desktop/package.json",
    "mobile/package.json",
    "web/package.json",
    "packages/client/package.json",
    "packages/protocol",
  ]);
});

Deno.test("server snapshots reject likely secret files", async () => {
  const root = await createRepo();
  try {
    await Deno.writeTextFile(`${root}/server/private.key`, "not-a-real-key\n");
    let message = "";
    try {
      await createServerSnapshot(root);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(
      message.includes("private.key"),
      `Expected secret rejection, got: ${message}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("server snapshots reject unresolved merge conflicts", async () => {
  const root = await createRepo();
  try {
    await git(root, "checkout", "-qb", "other");
    await Deno.writeTextFile(
      `${root}/server/app.ts`,
      'export const value = "other";\n',
    );
    await git(root, "commit", "-qam", "other change");
    await git(root, "checkout", "-q", "-");
    await Deno.writeTextFile(
      `${root}/server/app.ts`,
      'export const value = "current";\n',
    );
    await git(root, "commit", "-qam", "current change");
    await new Deno.Command("git", {
      cwd: root,
      args: ["merge", "other"],
      stdout: "null",
      stderr: "null",
    }).output();

    let message = "";
    try {
      await createServerSnapshot(root);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(
      message.includes("Resolve merge conflicts"),
      `Expected conflict rejection, got: ${message}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("suspicious snapshot path rules allow committed examples", () => {
  assertEquals(isSuspiciousSnapshotPath("server/.env"), true);
  assertEquals(isSuspiciousSnapshotPath("server/.env.deploy"), true);
  assertEquals(isSuspiciousSnapshotPath("server/.env.deploy.example"), false);
  assertEquals(isSuspiciousSnapshotPath("server/cert.pem"), true);
  assertEquals(isSuspiciousSnapshotPath("server/src/server.ts"), false);
});

Deno.test("deployment ref push rejects a stale force-with-lease expectation", async () => {
  const root = await createRepo();
  const remote = await Deno.makeTempDir({ prefix: "weave-deploy-remote-" });
  try {
    await git(remote, "init", "--bare", "-q");
    await git(root, "remote", "add", "test", remote);
    await Deno.writeTextFile(
      `${root}/server/app.ts`,
      "export const value = 2;\n",
    );
    const first = await createServerSnapshot(root);
    await pushRefAtLease(
      root,
      "test",
      first.commit,
      "refs/heads/deploy/pi-dev",
      undefined,
    );

    await Deno.writeTextFile(
      `${root}/server/app.ts`,
      "export const value = 3;\n",
    );
    const second = await createServerSnapshot(root);
    let message = "";
    try {
      await pushRefAtLease(
        root,
        "test",
        second.commit,
        "refs/heads/deploy/pi-dev",
        first.parent,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.length > 0, "stale force-with-lease unexpectedly succeeded");
    assertEquals(
      await git(
        root,
        "ls-remote",
        "--heads",
        "test",
        "refs/heads/deploy/pi-dev",
      ).then((line) => line.split(/\s+/)[0]),
      first.commit,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(remote, { recursive: true });
  }
});

const testDokploy = (
  terminalStatus: "done" | "error" | "cancelled" | "running" | "token-error",
) => {
  let triggered = false;
  let polls = 0;
  let authFailures = 0;
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => undefined,
  }, (request) => {
    if (request.headers.get("x-api-key") !== "test-token") {
      authFailures += 1;
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = new URL(request.url);
    if (url.pathname === "/api/compose.deploy") {
      if (terminalStatus === "token-error") {
        return new Response("request rejected for test-token", { status: 500 });
      }
      triggered = true;
      return Response.json({ success: true });
    }
    if (url.pathname === "/api/deployment.allByCompose") {
      if (!triggered) return Response.json([]);
      polls += 1;
      return Response.json([{
        deploymentId: "deployment-1",
        title: "test deployment",
        status: polls === 1
          ? "queued"
          : polls === 2 || terminalStatus === "token-error"
          ? "running"
          : terminalStatus,
        ...(terminalStatus === "error" ? { errorMessage: "build failed" } : {}),
      }]);
    }
    if (url.pathname === "/api/deployment.readLogs") {
      return Response.json({ logs: "remote build log" });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  });
  const address = server.addr as Deno.NetAddr;
  const config: DokployConfig = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    composeId: "compose-1",
    token: "test-token",
    timeoutMs: 2000,
    pollIntervalMs: 1,
  };
  return { server, config, authFailures: () => authFailures };
};

Deno.test("Dokploy client waits for a successful deployment with API-key auth", async () => {
  const fake = testDokploy("done");
  try {
    const deployment = await triggerAndWaitForDeployment(
      fake.config,
      "test deployment",
      "test",
    );
    assertEquals(deployment.status, "done");
    assertEquals(fake.authFailures(), 0);
  } finally {
    await fake.server.shutdown();
  }
});

Deno.test("Dokploy client includes remote logs when deployment fails", async () => {
  const fake = testDokploy("error");
  try {
    let message = "";
    try {
      await triggerAndWaitForDeployment(fake.config, "test deployment", "test");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(
      message.includes("build failed"),
      `Expected deployment error, got: ${message}`,
    );
    assert(
      message.includes("remote build log"),
      `Expected deployment logs, got: ${message}`,
    );
  } finally {
    await fake.server.shutdown();
  }
});

Deno.test("Dokploy client reports cancelled deployments with logs", async () => {
  const fake = testDokploy("cancelled");
  try {
    let message = "";
    try {
      await triggerAndWaitForDeployment(fake.config, "test deployment", "test");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(
      message.includes("cancelled"),
      `Expected cancellation, got: ${message}`,
    );
    assert(
      message.includes("remote build log"),
      `Expected deployment logs, got: ${message}`,
    );
  } finally {
    await fake.server.shutdown();
  }
});

Deno.test("Dokploy client times out while deployment remains running", async () => {
  const fake = testDokploy("running");
  fake.config.timeoutMs = 5;
  try {
    let message = "";
    try {
      await triggerAndWaitForDeployment(fake.config, "test deployment", "test");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes("Timed out"), `Expected timeout, got: ${message}`);
  } finally {
    await fake.server.shutdown();
  }
});

Deno.test("Dokploy client redacts its API token from error responses", async () => {
  const fake = testDokploy("token-error");
  try {
    let message = "";
    try {
      await triggerAndWaitForDeployment(fake.config, "test deployment", "test");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(
      message.includes("[REDACTED]"),
      `Expected redacted token marker, got: ${message}`,
    );
    assert(
      !message.includes("test-token"),
      `API token leaked in error: ${message}`,
    );
  } finally {
    await fake.server.shutdown();
  }
});
