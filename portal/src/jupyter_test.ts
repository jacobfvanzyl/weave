import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import {
  __jupyterTest,
  isJupyterClientEnvelope,
  PortalJupyterHost,
  type PortalJupyterHostEvent,
  type PortalJupyterRuntime,
} from "./jupyter.ts";

type CommandCall = {
  args: string[];
  command: string;
  cwd?: string;
  env?: Record<string, string>;
};

const successfulCommand = {
  code: 0,
  stderr: "",
  stdout: "",
  success: true,
};

const failedCommand = {
  code: 1,
  stderr: "",
  stdout: "",
  success: false,
};

class MockJupyterRuntime implements PortalJupyterRuntime {
  executeCalls: unknown[] = [];
  detachedSessions: string[] = [];
  disposed = false;

  async status() {
    return {
      ok: true as const,
      available: true,
      status: "ready" as const,
      command: "jupyter",
      rootPath: "/workspace",
    };
  }

  async kernelspecs() {
    return {
      ok: true as const,
      available: true,
      defaultKernelName: "python3",
      kernelspecs: [
        {
          name: "python3",
          displayName: "Python 3",
          language: "python",
        },
      ],
    };
  }

  async createSession() {
    return {
      ok: true as const,
      available: true,
      sessionId: "session-1",
      kernelId: "kernel-1",
      kernelName: "python3",
      rootPath: "/workspace",
      path: "Notebook.cpr",
    };
  }

  async execute(
    input: Parameters<PortalJupyterRuntime["execute"]>[0],
    send: Parameters<PortalJupyterRuntime["execute"]>[1],
  ) {
    this.executeCalls.push(input);
    send({
      type: "status",
      sessionId: input.sessionId,
      requestId: input.requestId,
      cellId: input.cellId,
      executionState: "busy",
    });
    send({
      type: "execution_input",
      sessionId: input.sessionId,
      requestId: input.requestId,
      cellId: input.cellId,
      executionCount: 3,
    });
    send({
      type: "clear_output",
      sessionId: input.sessionId,
      requestId: input.requestId,
      cellId: input.cellId,
      wait: false,
    });
    send({
      type: "output",
      sessionId: input.sessionId,
      requestId: input.requestId,
      cellId: input.cellId,
      output: {
        output_type: "stream",
        name: "stdout",
        text: "hello\n",
      },
    });
    send({
      type: "complete",
      sessionId: input.sessionId,
      requestId: input.requestId,
      cellId: input.cellId,
      status: "ok",
      executionCount: 3,
    });
  }

  detachSession(sessionId: string) {
    this.detachedSessions.push(sessionId);
  }

  dispose() {
    this.disposed = true;
  }
}

Deno.test("PortalJupyterHost reports status, kernelspecs, sessions, execute streams, and detach", async () => {
  const runtime = new MockJupyterRuntime();
  const host = new PortalJupyterHost({ config: {}, runtime });
  const events: PortalJupyterHostEvent[] = [];

  assertEquals(await host.status({ workspacePath: "/workspace" }), {
    ok: true,
    available: true,
    status: "ready",
    command: "jupyter",
    rootPath: "/workspace",
  });
  assertEquals(await host.kernelspecs({ workspacePath: "/workspace" }), {
    ok: true,
    available: true,
    defaultKernelName: "python3",
    kernelspecs: [{
      name: "python3",
      displayName: "Python 3",
      language: "python",
    }],
  });
  assertEquals(
    await host.createSession({
      workspacePath: "/workspace",
      path: "Notebook.cpr",
    }),
    {
      ok: true,
      available: true,
      sessionId: "session-1",
      kernelId: "kernel-1",
      kernelName: "python3",
      rootPath: "/workspace",
      path: "Notebook.cpr",
    },
  );

  await host.handleClientMessage(
    "relay-jupyter:test",
    {
      type: "execute",
      sessionId: "session-1",
      requestId: "request-1",
      cellId: "cell-1",
      code: 'print("hello")',
      allowStdin: false,
      storeHistory: true,
    },
    (event) => events.push(event),
  );

  assertEquals(runtime.executeCalls, [{
    type: "execute",
    sessionId: "session-1",
    requestId: "request-1",
    cellId: "cell-1",
    code: 'print("hello")',
    allowStdin: false,
    storeHistory: true,
  }]);
  assertEquals(events.map((event) => event.type), [
    "status",
    "execution_input",
    "clear_output",
    "output",
    "complete",
  ]);
  assertEquals(events.at(-1), {
    type: "complete",
    sessionId: "session-1",
    requestId: "request-1",
    cellId: "cell-1",
    status: "ok",
    executionCount: 3,
  });

  await host.handleClientMessage(
    "relay-jupyter:test",
    { type: "detach", sessionId: "session-1" },
    (event) => events.push(event),
  );
  assertEquals(runtime.detachedSessions, ["session-1"]);
  await host.dispose();
  assertEquals(runtime.disposed, true);
});

Deno.test("LocalJupyterRuntime reports missing uv for workspace Python kernels", async () => {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "weave-jupyter-uv-missing-" }),
  );
  try {
    const runtime = new __jupyterTest.LocalJupyterRuntime({}, {
      commandRunner: async (command) =>
        command === "jupyter" ? successfulCommand : failedCommand,
    });

    const status = await runtime.status({ workspacePath: root });

    assertEquals(status.available, false);
    assertEquals(status.status, "missing");
    assertEquals(status.command, "jupyter");
    assertEquals(status.uvAvailable, false);
    assertEquals(status.uvCommand, "uv");
    assertEquals(status.workspaceKernelName, "coppermind-python");
    assertStringIncludes(status.error ?? "", "uv is required");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("Jupyter command resolution checks user and Homebrew install paths when PATH is sparse", async () => {
  const calls: CommandCall[] = [];
  const resolved = await __jupyterTest.resolveCommand(
    "uv",
    async (command, args, options) => {
      calls.push({ command, args, cwd: options?.cwd, env: options?.env });
      return command === "/Users/test/.local/bin/uv"
        ? successfulCommand
        : failedCommand;
    },
    { HOME: "/Users/test", PATH: "/usr/bin:/bin" },
  );

  assertEquals(resolved, "/Users/test/.local/bin/uv");
  assertEquals(calls.map((call) => call.command), [
    "uv",
    "/usr/bin/uv",
    "/bin/uv",
    "/Users/test/.local/bin/uv",
  ]);
});

Deno.test("Jupyter default command runner handles suppressed output streams", async () => {
  const output = await __jupyterTest.defaultCommandRunner(Deno.execPath(), [
    "--version",
  ], {
    stderr: "null",
    stdout: "null",
  });

  assertEquals(output.success, true);
  assertEquals(output.stderr, "");
  assertEquals(output.stdout, "");
});

Deno.test("workspace Python environment preparation creates venv, installs ipykernel, and writes kernelspec", async () => {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "weave-jupyter-env-" }),
  );
  const portalHome = await Deno.makeTempDir({ prefix: "weave-jupyter-portal-home-" });
  const env = {
    HOME: "/Users/test",
    PATH: "/usr/bin:/bin",
    WEAVE_PORTAL_HOME: portalHome,
  };
  const calls: CommandCall[] = [];
  try {
    const expected = __jupyterTest.workspacePythonEnvironmentPaths(root, env);
    const environment = await __jupyterTest.prepareWorkspacePythonEnvironment(
      root,
      {
        env,
        commandRunner: async (command, args, options) => {
          calls.push({ command, args, cwd: options?.cwd, env: options?.env });
          if (
            command === "uv" && args[0] === "--version"
          ) return successfulCommand;
          if (command === "uv" && args[0] === "venv") return successfulCommand;
          if (
            command === expected.pythonPath &&
            args.join(" ") === "-c import ipykernel"
          ) return failedCommand;
          if (
            command === "uv" && args.slice(0, 2).join(" ") === "pip install"
          ) return successfulCommand;
          return failedCommand;
        },
      },
    );

    assertEquals(environment.venvPath, expected.venvPath);
    assertEquals(environment.environmentPath, expected.environmentPath);
    assertEquals(environment.venvPath.startsWith(root), false);
    assertEquals(
      calls.some((call) =>
        call.command === "uv" &&
        call.cwd === root &&
        call.args.join(" ") === `venv --seed ${expected.venvPath}`
      ),
      true,
    );
    assertEquals(
      calls.some((call) =>
        call.command === "uv" &&
        call.cwd === root &&
        call.args.join(" ") ===
          `pip install --python ${expected.pythonPath} ipykernel`
      ),
      true,
    );

    const kernelspec = JSON.parse(
      await Deno.readTextFile(environment.kernelspecPath),
    );
    assertEquals(kernelspec.argv, [
      expected.pythonPath,
      "-m",
      "ipykernel_launcher",
      "-f",
      "{connection_file}",
    ]);
    assertEquals(kernelspec.display_name, "Coppermind Python");
    assertEquals(kernelspec.language, "python");
    assertEquals(kernelspec.env.VIRTUAL_ENV, expected.venvPath);
    assertEquals(kernelspec.env.PYTHONNOUSERSITE, "1");
    assertStringIncludes(kernelspec.env.PATH, expected.binPath);
    assertStringIncludes(kernelspec.env.PATH, "/Users/test/.local/bin");
    assertStringIncludes(kernelspec.env.PATH, "/opt/homebrew/bin");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(portalHome, { recursive: true });
  }
});

Deno.test("workspace Python environment preparation skips install when ipykernel is present", async () => {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "weave-jupyter-env-present-" }),
  );
  const portalHome = await Deno.makeTempDir({ prefix: "weave-jupyter-portal-home-present-" });
  const env = { WEAVE_PORTAL_HOME: portalHome };
  const calls: CommandCall[] = [];
  try {
    const expected = __jupyterTest.workspacePythonEnvironmentPaths(root, env);
    await Deno.mkdir(expected.venvPath, { recursive: true });

    await __jupyterTest.prepareWorkspacePythonEnvironment(root, {
      env,
      commandRunner: async (command, args, options) => {
        calls.push({ command, args, cwd: options?.cwd, env: options?.env });
        if (command === "uv" && args[0] === "--version") {
          return successfulCommand;
        }
        if (
          command === expected.pythonPath &&
          args.join(" ") === "-c import ipykernel"
        ) return successfulCommand;
        return failedCommand;
      },
    });

    assertEquals(
      calls.some((call) => call.command === "uv" && call.args[0] === "venv"),
      false,
    );
    assertEquals(
      calls.some((call) =>
        call.command === "uv" &&
        call.args.slice(0, 2).join(" ") === "pip install"
      ),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(portalHome, { recursive: true });
  }
});

Deno.test("workspace Python environment preparation is serialized per root", async () => {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "weave-jupyter-env-serialized-" }),
  );
  const portalHome = await Deno.makeTempDir({ prefix: "weave-jupyter-portal-home-serialized-" });
  const env = { WEAVE_PORTAL_HOME: portalHome };
  let venvCalls = 0;
  try {
    const expected = __jupyterTest.workspacePythonEnvironmentPaths(root, env);
    const runtime = new __jupyterTest.LocalJupyterRuntime({}, {
      env,
      commandRunner: async (command, args) => {
        if (command === "uv" && args[0] === "--version") {
          return successfulCommand;
        }
        if (command === "uv" && args[0] === "venv") {
          venvCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return successfulCommand;
        }
        if (
          command === expected.pythonPath &&
          args.join(" ") === "-c import ipykernel"
        ) return successfulCommand;
        return failedCommand;
      },
    });

    const [first, second] = await Promise.all([
      (runtime as any).ensureWorkspacePythonEnvironment(root),
      (runtime as any).ensureWorkspacePythonEnvironment(root),
    ]);

    assertEquals(first, second);
    assertEquals(venvCalls, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(portalHome, { recursive: true });
  }
});

Deno.test("Jupyter workspace kernel env is used for server discovery and Python session defaulting", () => {
  const environment = __jupyterTest.workspacePythonEnvironmentPaths(
    "/workspace",
    {
      HOME: "/Users/test",
      JUPYTER_PATH: "/existing/jupyter",
      PATH: "/usr/bin:/bin",
    },
  );

  assertEquals(
    __jupyterTest.jupyterServerEnv(environment, {
      JUPYTER_PATH: "/existing/jupyter",
    }),
    {
      JUPYTER_PATH: `${environment.venvPath}/share/jupyter:/existing/jupyter`,
    },
  );
  assertEquals(environment.kernelEnv.VIRTUAL_ENV, environment.venvPath);
  assertEquals(environment.kernelEnv.PYTHONNOUSERSITE, "1");
  assertEquals(
    environment.kernelEnv.PATH,
    `${environment.venvPath}/bin:/usr/bin:/bin:/Users/test/.local/bin:/Users/test/.cargo/bin:/opt/homebrew/bin:/usr/local/bin`,
  );
  assertEquals(
    __jupyterTest.selectJupyterKernelName({ language: "python" }),
    "coppermind-python",
  );
  assertEquals(
    __jupyterTest.selectJupyterKernelName({ language: "typescript" }),
    "python3",
  );
  assertEquals(
    __jupyterTest.selectJupyterKernelName({
      kernelName: "python3",
      language: "python",
    }),
    "python3",
  );
});

Deno.test("PortalJupyterHost converts runtime execution failures to Jupyter error events", async () => {
  const runtime = new MockJupyterRuntime();
  runtime.execute = async () => {
    throw new Error("kernel unavailable");
  };
  const host = new PortalJupyterHost({ config: {}, runtime });
  const events: PortalJupyterHostEvent[] = [];

  await host.handleClientMessage(
    "relay-jupyter:test",
    {
      type: "execute",
      sessionId: "session-1",
      requestId: "request-1",
      cellId: "cell-1",
      code: "raise RuntimeError()",
    },
    (event) => events.push(event),
  );

  assertEquals(events, [{
    type: "error",
    sessionId: "session-1",
    requestId: "request-1",
    cellId: "cell-1",
    error: "kernel unavailable",
  }]);
});

Deno.test("Jupyter message helpers normalize protocol output messages", () => {
  assertEquals(
    isJupyterClientEnvelope({
      type: "jupyter.client",
      clientId: "client-1",
      message: { type: "execute", sessionId: "session-1", code: "1 + 1" },
    }),
    true,
  );
  assertEquals(
    __jupyterTest.outputFromJupyterMessage("stream", {
      name: "stdout",
      text: ["hello", "\n"],
    }),
    {
      output_type: "stream",
      name: "stdout",
      text: "hello\n",
    },
  );
  assertEquals(
    __jupyterTest.outputFromJupyterMessage("stream", {
      name: "stderr",
      text: "\x1b[31mModuleNotFoundError\x1b[39m\r\x1b[2KModuleNotFoundError\n",
    }),
    {
      output_type: "stream",
      name: "stderr",
      text: "\x1b[31mModuleNotFoundError\x1b[39m\r\x1b[2KModuleNotFoundError\n",
    },
  );
  assertEquals(
    __jupyterTest.outputFromJupyterMessage("error", {
      ename: "ValueError",
      evalue: "bad",
      traceback: ["line 1", "ValueError: bad"],
    }),
    {
      output_type: "error",
      ename: "ValueError",
      evalue: "bad",
      traceback: ["line 1", "ValueError: bad"],
    },
  );
  assertEquals(
    __jupyterTest.outputFromJupyterMessage("error", {
      ename: "ModuleNotFoundError",
      evalue: "No module named 'supabase'",
      traceback: [
        "\x1b[31mModuleNotFoundError\x1b[39m: No module named supabase",
      ],
    }),
    {
      output_type: "error",
      ename: "ModuleNotFoundError",
      evalue: "No module named 'supabase'",
      traceback: [
        "\x1b[31mModuleNotFoundError\x1b[39m: No module named supabase",
      ],
    },
  );
  assertEquals(
    __jupyterTest.outputFromJupyterMessage("execute_result", {
      execution_count: 4,
      data: { "text/plain": "2" },
      metadata: {},
    }),
    {
      output_type: "execute_result",
      execution_count: 4,
      data: { "text/plain": "2" },
      metadata: {},
    },
  );
});
