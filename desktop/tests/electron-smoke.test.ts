import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  _electron as electron,
  type ElectronApplication,
  expect as playwrightExpect,
  type Locator,
} from "@playwright/test";
import { WEAVE_RPC_PROTOCOL_VERSION } from "@weave/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

const runSmoke = process.env.WEAVE_ELECTRON_SMOKE === "1";
const testDirectory = path.dirname(fileURLToPath(import.meta.url));

describe.skipIf(!runSmoke)("Weave Electron smoke", () => {
  let app: ElectronApplication | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let rpcServer: WebSocketServer | undefined;
  let serverUrl = "";
  let userDataPath = "";
  let scrollThreadMessages: Array<Record<string, unknown>> = [];

  beforeEach(async () => {
    const now = new Date().toISOString();
    const longText = (label: string) =>
      `${label} ${
        "Long rendered chat content keeps this regression thread scrollable. "
          .repeat(18)
      }`;
    scrollThreadMessages = Array.from({ length: 12 }, (_, index) => [
      {
        id: `scroll-user-${index}`,
        role: "user",
        parts: [{ type: "text", text: longText(`Question ${index + 1}.`) }],
      },
      {
        id: `scroll-assistant-${index}`,
        role: "assistant",
        status: { type: "complete" },
        parts: [{ type: "text", text: longText(`Answer ${index + 1}.`) }],
      },
    ]).flat();
    scrollThreadMessages.push(
      {
        id: "scroll-user-timed",
        role: "user",
        parts: [{ type: "text", text: "Finish the historical timed task." }],
      },
      {
        id: "scroll-assistant-timed",
        role: "assistant",
        status: { type: "complete" },
        metadata: {
          weaveRunTiming: { status: "completed", durationMs: 65_000 },
        },
        parts: [
          {
            type: "text",
            text: "Historical work details should start collapsed.",
          },
          {
            type: "tool-read",
            toolCallId: "historical-read",
            input: { path: "historical.ts" },
            output: "ok",
            state: "output-available",
          },
          { type: "text", text: "Historical final response." },
        ],
      },
    );
    const codeProject = {
      id: "project-1",
      userId: "smoke-user",
      name: "Smoke Code",
      projectKind: "git",
      portalId: "smoke-portal",
      portalRootId: "default",
      repoPath: "/tmp/smoke",
      sortOrder: 0,
      workspaces: [{
        id: "workspace-1",
        projectId: "project-1",
        portalId: "smoke-portal",
        workspaceKind: "primary",
        source: "primary",
        name: "main",
        path: "/tmp/smoke",
        status: "ready",
        locked: true,
        createdAt: now,
        updatedAt: now,
      }],
      createdAt: now,
      updatedAt: now,
    };
    const notesProject = {
      id: "notes-project",
      userId: "smoke-user",
      name: "Smoke Notes",
      projectKind: "notes",
      portalId: "smoke-portal",
      portalRootId: "default",
      vaultPath: "/tmp/notes",
      notesStorage: {
        kind: "portal",
        portalId: "smoke-portal",
        rootId: "default",
        vaultPath: "/tmp/notes",
      },
      sortOrder: 1,
      workspaces: [{
        id: "notes-workspace",
        projectId: "notes-project",
        portalId: "smoke-portal",
        workspaceKind: "primary",
        source: "primary",
        name: "Vault",
        path: "/tmp/notes",
        status: "ready",
        locked: true,
        createdAt: now,
        updatedAt: now,
      }],
      createdAt: now,
      updatedAt: now,
    };
    const generalProject = {
      id: "general-project",
      userId: "smoke-user",
      name: "Smoke Threads",
      projectKind: "general",
      sortOrder: 2,
      workspaces: [],
      createdAt: now,
      updatedAt: now,
    };
    const allProjects = [codeProject, notesProject, generalProject];
    const smokeThreads = [{
      id: "plain-thread",
      title: "Loose thought",
      createdAt: now,
      updatedAt: now,
      metadata: { sortOrder: 0 },
    }, {
      id: "code-thread",
      title: "Code workspace thread",
      createdAt: now,
      updatedAt: now,
      metadata: {
        mode: "project",
        projectId: "project-1",
        workspaceId: "workspace-1",
        sortOrder: 0,
      },
    }, {
      id: "general-thread",
      title: "General project thread",
      createdAt: now,
      updatedAt: now,
      metadata: { mode: "project", projectId: "general-project", sortOrder: 0 },
    }, {
      id: "notes-thread",
      title: "Notes project thread",
      createdAt: now,
      updatedAt: now,
      metadata: {
        mode: "project",
        projectId: "notes-project",
        workspaceId: "notes-workspace",
        sortOrder: 0,
      },
    }, {
      id: "scroll-thread",
      title: "Scroll regression thread",
      createdAt: now,
      updatedAt: now,
      metadata: { sortOrder: 1 },
    }];
    server = createServer((request, response) => {
      if (request.url === "/health") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    });
    rpcServer = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      if (request.url !== "/rpc") {
        socket.destroy();
        return;
      }
      rpcServer?.handleUpgrade(
        request,
        socket,
        head,
        (ws) => rpcServer?.emit("connection", ws, request),
      );
    });
    rpcServer.on("connection", (socket) => {
      socket.on("message", (payload) => {
        const message = JSON.parse(payload.toString()) as {
          id?: string | number;
          method?: string;
          params?: Record<string, unknown>;
        };
        if (message.id === undefined || !message.method) return;
        const respond = (result: unknown) =>
          socket.send(
            JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
          );
        if (message.method === "initialize") {
          if (message.params?.token !== "test-token") {
            socket.send(JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32001,
                message: "Authentication failed.",
                data: { code: "UNAUTHENTICATED" },
              },
            }));
            socket.close(4401, "Authentication failed.");
            return;
          }
          respond({
            protocolVersion: WEAVE_RPC_PROTOCOL_VERSION,
            connectionId: `smoke_${crypto.randomUUID()}`,
            role: "client",
            heartbeatIntervalMs: 20_000,
            maxFrameBytes: 1024 * 1024,
            capabilities: [],
            owner: { id: "smoke-user", name: "Smoke User" },
          });
          return;
        }
        const result = (() => {
          switch (message.method) {
            case "owner.get":
              return { owner: { id: "smoke-user", name: "Smoke User" } };
            case "agent.models.list":
              return { defaultModel: "openai/gpt-5.5", options: [] };
            case "agent.chatgpt.authStatus":
              return { connected: true, accountId: "smoke-chatgpt" };
            case "code.project.list": {
              const product = message.params?.product;
              return {
                projects: product === "code"
                  ? [codeProject]
                  : product === "notes"
                  ? [notesProject]
                  : product === "chat"
                  ? [generalProject]
                  : allProjects,
              };
            }
            case "code.workspace.gitState.list":
              return { states: [] };
            case "chat.thread.list":
              return { threads: smokeThreads };
            case "chat.thread.messages.list":
              return {
                messages: message.params?.threadId === "scroll-thread"
                  ? scrollThreadMessages
                  : [],
              };
            case "chat.run.get":
              return { run: { active: false, status: "idle" } };
            case "chat.thread.contextUsage":
              return {
                modelId: "openai/gpt-5.5",
                tokens: 0,
                contextWindow: 128_000,
                contextLimitPercent: 80,
                contextLimitTokens: 102_400,
                percent: 0,
                compactionEnabled: true,
                source: "estimate",
              };
            case "workspaceFile.index":
              return {
                path: "",
                entries: [],
                notes: [],
                attachments: [],
                backlinks: {},
                checkedAt: now,
              };
            case "workspaceFile.list":
              return {
                path: typeof message.params?.path === "string"
                  ? message.params.path
                  : "",
                entries: [],
              };
            case "portal.list":
              return {
                portals: [{
                  portalId: "smoke-portal",
                  userId: "smoke-user",
                  name: "Smoke Portal",
                  status: "online",
                  capabilities: ["terminal"],
                  roots: [{ id: "default", name: "Default" }],
                  primary: true,
                }],
              };
            case "notification.subscribe":
              return { subscriptionId: "smoke-notifications", lastSequence: 0 };
            case "agent.prompts.list":
              return { prompts: [] };
            case "client.surface.update":
              return { ok: true };
            default:
              return null;
          }
        })();
        respond(result);
      });
    });

    await new Promise<void>((resolve) => {
      server?.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Smoke server did not start.");
    }
    serverUrl = `http://127.0.0.1:${address.port}`;
    userDataPath = mkdtempSync(path.join(tmpdir(), "weave-smoke-"));
  });

  afterEach(async () => {
    await app?.close();
    rpcServer?.clients.forEach((socket) => socket.close());
    rpcServer?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    rmSync(userDataPath, { recursive: true, force: true });
  });

  it(
    "exercises disconnected auth, saved auth, merged Weave shell render, shortcuts, and no renderer Node API",
    async () => {
      app = await electron.launch({
        args: [path.resolve(testDirectory, "../.vite/build/main.js")],
        env: {
          ...process.env,
          WEAVE_DESKTOP_SERVER_URL: serverUrl,
          WEAVE_DESKTOP_USER_DATA: userDataPath,
          WEAVE_PORTAL_HOME: path.join(userDataPath, "portal"),
          WEAVE_AUTH_TOKEN: "",
        },
      });

      const page = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setSize(1800, 1000);
      });
      await page.setViewportSize({ width: 1800, height: 1000 });
      await page.waitForLoadState("domcontentloaded");
      await page.getByLabel("Auth token").waitFor({ timeout: 5_000 });

      await page.getByLabel("Auth token").fill("test-token");
      await page.getByRole("button", { name: "Save" }).click();
      await page.getByLabel("Connection settings").waitFor({ timeout: 5_000 });
      expect(await app.evaluate(({ app }) => app.getName())).toBe("Weave");
      await playwrightExpect(page).toHaveTitle("Weave");
      expect(await page.locator("html").getAttribute("data-weave-client-app"))
        .toBe("weave");
      const hideSidebarAppRegion = await page.getByRole("button", {
        name: "Hide sidebar",
      }).evaluate((element) =>
        getComputedStyle(element).getPropertyValue("-webkit-app-region")
      );
      const hideSidebarIconAppRegion = await page.getByRole("button", {
        name: "Hide sidebar",
      }).locator("svg").evaluate((element) =>
        getComputedStyle(element).getPropertyValue("-webkit-app-region")
      );
      expect(hideSidebarAppRegion === "drag").toBe(false);
      expect(hideSidebarIconAppRegion === "drag").toBe(false);
      await playwrightExpect(
        page.getByRole("button", { name: "Switch to Notes" }),
      ).toHaveCount(0);
      await playwrightExpect(
        page.getByRole("button", { name: "Switch to Threads" }),
      ).toHaveCount(0);
      await playwrightExpect(
        page.getByRole("button", { name: "Switch to Code" }),
      ).toHaveCount(0);

      const sidebar = page.locator("[data-weave-thread-sidebar]");
      await playwrightExpect(sidebar.getByText("Loose thought")).toBeVisible({
        timeout: 5_000,
      });
      await playwrightExpect(sidebar.getByText("Smoke Code")).toBeVisible();
      await playwrightExpect(sidebar.getByText("Smoke Notes")).toBeVisible();
      await playwrightExpect(sidebar.getByText("Smoke Threads")).toBeVisible();
      await playwrightExpect(sidebar.getByText("Vaults", { exact: true }))
        .toHaveCount(0);
      await playwrightExpect(sidebar.getByText("Projects", { exact: true }))
        .toBeVisible();
      const threadBox = await sidebar.getByText("Loose thought").boundingBox();
      const notesBox = await sidebar.getByText("Smoke Notes").boundingBox();
      const notesThreadBox = await sidebar.getByText("Notes project thread")
        .boundingBox();
      const projectsBox = await sidebar.getByText("Projects", { exact: true })
        .boundingBox();
      const codeBox = await sidebar.getByText("Smoke Code").boundingBox();
      const threadsBox = await sidebar.getByText("Smoke Threads").boundingBox();
      expect(threadBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(
        notesBox?.y ?? 0,
      );
      expect(Math.abs((notesThreadBox?.x ?? 0) - (threadBox?.x ?? 0)))
        .toBeLessThanOrEqual(4);
      expect(notesBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(
        projectsBox?.y ?? 0,
      );
      expect(projectsBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(
        codeBox?.y ?? 0,
      );
      expect(projectsBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(
        threadsBox?.y ?? 0,
      );

      const plainThreadMetrics = await sidebar.getByRole("button", {
        name: /^Loose thought$/,
      }).evaluate((element) => {
        const row = element.parentElement;
        const highlight = row?.querySelector("[data-sidebar-highlight]");
        const rowRect = row?.getBoundingClientRect();
        const highlightRect = highlight?.getBoundingClientRect();
        return {
          height: rowRect?.height ?? 0,
          highlightRight: highlightRect?.right ?? 0,
        };
      });
      const notesThreadMetrics = await sidebar.getByRole("button", {
        name: /^Notes project thread$/,
      }).evaluate((element) => {
        const row = element.parentElement;
        const highlight = row?.querySelector("[data-sidebar-highlight]");
        const highlightRect = highlight?.getBoundingClientRect();
        return {
          highlightRight: highlightRect?.right ?? 0,
        };
      });
      const notesVaultTitle = sidebar.getByRole("button", {
        name: "Select Smoke Notes",
        exact: true,
      });
      const notesVaultTitleBox = await notesVaultTitle.boundingBox();
      expect(
        Math.abs((notesVaultTitleBox?.height ?? 0) - plainThreadMetrics.height),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(
          ((notesVaultTitleBox?.x ?? 0) + (notesVaultTitleBox?.width ?? 0)) -
            plainThreadMetrics.highlightRight,
        ),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(
          notesThreadMetrics.highlightRight - plainThreadMetrics.highlightRight,
        ),
      ).toBeLessThanOrEqual(1);
      const controlCenterX = (locator: Locator) =>
        locator.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return rect.left + rect.width / 2;
        });
      const threadsCreateCenterX = await controlCenterX(
        sidebar.getByRole("button", { name: /^Create Thread$/ }),
      );
      const threadsMenuCenterX = await controlCenterX(
        sidebar.getByRole("button", { name: /^Threads menu$/ }),
      );
      const vaultCreateCenterX = await controlCenterX(
        sidebar.getByRole("button", { name: /^Create thread in Smoke Notes$/ }),
      );
      const vaultMenuCenterX = await controlCenterX(
        sidebar.getByRole("button", { name: /^Smoke Notes menu$/ }),
      );
      const projectsMenuCenterX = await controlCenterX(
        sidebar.getByRole("button", { name: /^Projects menu$/ }),
      );
      expect(Math.abs(vaultCreateCenterX - threadsCreateCenterX))
        .toBeLessThanOrEqual(1);
      expect(Math.abs(vaultMenuCenterX - threadsMenuCenterX))
        .toBeLessThanOrEqual(1);
      expect(Math.abs(projectsMenuCenterX - threadsMenuCenterX))
        .toBeLessThanOrEqual(1);

      const appHeader = page.locator("header").first();
      const appBarBreadcrumb = appHeader.locator(
        "[data-weave-context-breadcrumb]",
      );
      const codeWorkspaceTitle = sidebar.getByRole("button", { name: /main/ })
        .first();
      const codeWorkspaceThread = () =>
        sidebar.getByRole("button", { name: /^Code workspace thread$/ });
      const notesProjectThread = () =>
        sidebar.getByRole("button", { name: /^Notes project thread$/ });
      const hasSelectedHighlight = async (locator: Locator) => {
        if (await locator.count() === 0) return false;
        return locator.evaluate((element) => {
          if (element.classList.contains("bg-selected-thread")) return true;
          let current = element.parentElement;
          while (current) {
            const highlight = current.querySelector("[data-sidebar-highlight]");
            if (highlight) {
              return highlight.classList.contains("bg-selected-thread");
            }
            current = current.parentElement;
          }
          return false;
        });
      };
      const reopenSidebarIfHidden = async () => {
        if (await sidebar.isVisible()) return;
        const showSidebar = page.getByRole("button", { name: "Show sidebar" })
          .first();
        await showSidebar.waitFor({ state: "visible", timeout: 5_000 });
        await showSidebar.click();
        await sidebar.waitFor({ timeout: 5_000 });
      };
      await playwrightExpect(
        page.getByRole("button", { name: "Show general terminal" }),
      ).toBeVisible();
      await playwrightExpect(
        page.getByRole("button", { name: "Show terminal" }),
      ).toHaveCount(0);

      await codeWorkspaceTitle.click({ force: true });
      await playwrightExpect(appBarBreadcrumb).toBeVisible({ timeout: 5_000 });
      await playwrightExpect(appBarBreadcrumb).toContainText("Smoke Code");
      await playwrightExpect(appBarBreadcrumb).toContainText("main");
      await playwrightExpect(
        page.locator(
          '[data-weave-main-pane="editor"] [data-weave-context-breadcrumb]',
        ),
      ).toHaveCount(0);
      await playwrightExpect(
        page.locator(
          '[data-weave-main-pane="chat"] [data-weave-context-breadcrumb]',
        ),
      ).toHaveCount(0);
      const generalTerminalToggle = page.getByRole("button", {
        name: "Show general terminal",
      });
      await generalTerminalToggle.waitFor({ timeout: 5_000 });
      await playwrightExpect(
        generalTerminalToggle.locator("[data-weave-terminal-count-badge]"),
      ).toHaveCount(0);
      await playwrightExpect(
        page.getByRole("button", { name: "Show terminal" }),
      ).toBeVisible();

      await codeWorkspaceThread().waitFor({ state: "visible", timeout: 5_000 });
      await codeWorkspaceThread().click();
      await playwrightExpect(
        appHeader.getByRole("button", { name: "Hide chat" }),
      ).toBeVisible();
      await reopenSidebarIfHidden();
      expect(await hasSelectedHighlight(codeWorkspaceThread())).toBe(true);
      await appHeader.getByRole("button", { name: "Hide chat" }).click();
      await reopenSidebarIfHidden();
      expect(await hasSelectedHighlight(codeWorkspaceThread())).toBe(false);
      expect(await hasSelectedHighlight(codeWorkspaceTitle)).toBe(true);

      await reopenSidebarIfHidden();
      await notesProjectThread().waitFor({ state: "visible", timeout: 5_000 });
      await notesProjectThread().click();
      await playwrightExpect(appBarBreadcrumb).toContainText("Smoke Notes");
      await playwrightExpect(appBarBreadcrumb).toContainText("Vault");
      await playwrightExpect(
        appHeader.getByRole("button", { name: "Hide chat" }),
      ).toBeVisible();
      await reopenSidebarIfHidden();
      expect(await hasSelectedHighlight(notesProjectThread())).toBe(true);
      await appHeader.getByRole("button", { name: "Hide chat" }).click();
      await reopenSidebarIfHidden();
      expect(await hasSelectedHighlight(notesProjectThread())).toBe(false);
      expect(await hasSelectedHighlight(notesVaultTitle)).toBe(true);
      await playwrightExpect(
        page.getByRole("button", { name: "Show general terminal" }),
      ).toBeVisible();
      await playwrightExpect(
        page.getByRole("button", { name: "Show terminal" }),
      ).toHaveCount(0);
      await playwrightExpect(
        appHeader.getByRole("button", { name: "Hide notes" }),
      ).toBeVisible();

      await sidebar.getByRole("button", { name: /^Loose thought$/ }).click({
        force: true,
      });
      await playwrightExpect(appBarBreadcrumb).toContainText("Loose thought");
      await playwrightExpect(
        page.locator(
          '[data-weave-main-pane="chat"] [data-weave-context-breadcrumb]',
        ),
      ).toHaveCount(0);
      await playwrightExpect(
        page.getByRole("button", { name: "Show general terminal" }),
      ).toBeVisible();
      await playwrightExpect(
        page.getByRole("button", { name: "Show terminal" }),
      ).toHaveCount(0);
      await playwrightExpect(page.getByRole("button", { name: "Hide notes" }))
        .toHaveCount(0);
      await playwrightExpect(page.getByRole("button", { name: "Show notes" }))
        .toHaveCount(0);

      await page.getByRole("button", { name: "Hide sidebar" }).click();
      const showSidebarButton = page.getByRole("button", {
        name: "Show sidebar",
      }).first();
      await showSidebarButton.waitFor({ timeout: 5_000 });
      await showSidebarButton.click();
      await page.getByRole("button", { name: "Hide sidebar" }).waitFor({
        timeout: 5_000,
      });

      const shortcut = process.platform === "darwin" ? "Meta+K" : "Control+K";
      const composer = page.locator(
        '[data-weave-active-thread="true"] textarea',
      );
      await composer.waitFor({ state: "visible", timeout: 5_000 });
      await playwrightExpect(composer).toBeEnabled({ timeout: 5_000 });
      const shortcutOverlay = page.locator("[data-weave-shortcut-overlay]");
      await page.getByRole("button", { name: "Hide sidebar" }).focus();
      await page.keyboard.press(shortcut);
      await playwrightExpect(shortcutOverlay).toBeVisible({ timeout: 5_000 });
      await playwrightExpect(shortcutOverlay.getByText("Focus chat"))
        .toBeVisible({ timeout: 5_000 });
      await page.keyboard.press("c");
      await playwrightExpect(shortcutOverlay).toBeHidden({ timeout: 5_000 });
      await playwrightExpect(composer).toBeFocused({ timeout: 5_000 });

      await page.keyboard.press(shortcut);
      await page.keyboard.press("s");
      await page.getByRole("button", { name: "Show sidebar" }).first().waitFor({
        timeout: 5_000,
      });
      await page.waitForTimeout(900);
      await playwrightExpect(shortcutOverlay).toBeHidden({ timeout: 1_000 });

      await composer.focus({ timeout: 5_000 });
      await page.keyboard.press(shortcut);
      await playwrightExpect(shortcutOverlay).toBeVisible({ timeout: 5_000 });
      await playwrightExpect(shortcutOverlay.getByText("Toggle sidebar"))
        .toBeVisible({ timeout: 5_000 });
      await playwrightExpect(shortcutOverlay.getByText("Toggle chat pane"))
        .toBeVisible({ timeout: 5_000 });
      await playwrightExpect(shortcutOverlay.getByText("Toggle terminal pane"))
        .toBeVisible({ timeout: 5_000 });
      await playwrightExpect(shortcutOverlay.getByText("Toggle editor pane"))
        .toBeVisible({ timeout: 5_000 });
      await playwrightExpect(shortcutOverlay.getByText("Expand terminal pane"))
        .toHaveCount(0);
      await playwrightExpect(shortcutOverlay.getByText("Expand editor pane"))
        .toHaveCount(0);

      await page.keyboard.press("c");
      await playwrightExpect(shortcutOverlay).toBeHidden({ timeout: 5_000 });
      await playwrightExpect(
        page.getByRole("button", { name: "Show chat" }).first(),
      ).toBeVisible({ timeout: 5_000 });

      expect(await page.evaluate(() => typeof window.require)).toBe(
        "undefined",
      );
      expect(
        await page.locator("body").evaluate((element) =>
          getComputedStyle(element).colorScheme
        ),
      ).toBe("dark");
    },
    60_000,
  );

  it(
    "keeps a scrolled chat anchor through persisted refresh and reapplies timed collapse on reopen",
    async () => {
      app = await electron.launch({
        args: [path.resolve(testDirectory, "../.vite/build/main.js")],
        env: {
          ...process.env,
          WEAVE_DESKTOP_SERVER_URL: serverUrl,
          WEAVE_DESKTOP_USER_DATA: userDataPath,
          WEAVE_PORTAL_HOME: path.join(userDataPath, "portal"),
          WEAVE_AUTH_TOKEN: "",
        },
      });

      const page = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setSize(1200, 800);
      });
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.waitForLoadState("domcontentloaded");
      await page.getByLabel("Auth token").waitFor({ timeout: 5_000 });
      await page.getByLabel("Auth token").fill("test-token");
      await page.getByRole("button", { name: "Save" }).click();

      const sidebar = page.locator("[data-weave-thread-sidebar]");
      await sidebar.getByRole("button", { name: /^Scroll regression thread$/ })
        .click();
      await playwrightExpect(page.getByText("Historical final response."))
        .toBeVisible({ timeout: 5_000 });
      await playwrightExpect(
        page.getByRole("button", { name: "Show hidden work for this turn" }),
      ).toContainText("Worked for 1m05s");
      await playwrightExpect(
        page.getByText("Historical work details should start collapsed."),
      ).toHaveCount(0);

      const viewport = page.locator(
        '[data-weave-active-thread="true"] [data-weave-thread-viewport]',
      );
      await viewport.evaluate((element) => {
        element.scrollTop = Math.floor(
          (element.scrollHeight - element.clientHeight) * 0.45,
        );
        element.dispatchEvent(new Event("scroll"));
      });
      await page.waitForTimeout(500);
      const anchorBefore = await viewport.evaluate((element) => {
        const viewportTop = element.getBoundingClientRect().top;
        const message = Array.from(
          element.querySelectorAll<HTMLElement>("[data-message-id]"),
        )
          .find((candidate) =>
            candidate.getBoundingClientRect().bottom > viewportTop
          );
        return {
          atBottom:
            element.scrollHeight - element.scrollTop - element.clientHeight < 1,
          id: message?.dataset.messageId,
          offset: message
            ? message.getBoundingClientRect().top - viewportTop
            : undefined,
        };
      });
      expect(anchorBefore.atBottom).toBe(false);
      expect(anchorBefore.id).toBeTruthy();

      scrollThreadMessages = [
        ...scrollThreadMessages,
        {
          id: "scroll-user-refetched",
          role: "user",
          parts: [{ type: "text", text: "Finish the refetched timed task." }],
        },
        {
          id: "scroll-assistant-refetched",
          role: "assistant",
          status: { type: "complete" },
          metadata: {
            weaveRunTiming: { status: "completed", durationMs: 5_000 },
          },
          parts: [
            {
              type: "text",
              text:
                "Refetched work details must stay expanded while reading above.",
            },
            {
              type: "tool-read",
              toolCallId: "refetched-read",
              input: { path: "refetched.ts" },
              output: "ok",
              state: "output-available",
            },
            { type: "text", text: "Refetched completion marker." },
          ],
        },
      ];

      await playwrightExpect(page.getByText("Refetched completion marker."))
        .toHaveCount(1, { timeout: 9_000 });
      await playwrightExpect(
        page.getByText(
          "Refetched work details must stay expanded while reading above.",
        ),
      ).toHaveCount(1);
      await playwrightExpect(page.getByText("Worked for 5s")).toHaveCount(0);

      await page.waitForTimeout(500);
      const anchorAfter = await viewport.evaluate((element) => {
        const viewportTop = element.getBoundingClientRect().top;
        const message = Array.from(
          element.querySelectorAll<HTMLElement>("[data-message-id]"),
        )
          .find((candidate) =>
            candidate.getBoundingClientRect().bottom > viewportTop
          );
        return {
          atBottom:
            element.scrollHeight - element.scrollTop - element.clientHeight < 1,
          id: message?.dataset.messageId,
          offset: message
            ? message.getBoundingClientRect().top - viewportTop
            : undefined,
        };
      });
      expect(anchorAfter.atBottom).toBe(false);
      expect(anchorAfter.id).toBe(anchorBefore.id);
      expect(Math.abs((anchorAfter.offset ?? 0) - (anchorBefore.offset ?? 0)))
        .toBeLessThanOrEqual(1);

      await sidebar.getByRole("button", { name: /^Loose thought$/ }).click();
      await sidebar.getByRole("button", { name: /^Scroll regression thread$/ })
        .click();
      await playwrightExpect(page.getByText("Worked for 5s")).toBeVisible({
        timeout: 5_000,
      });
      await playwrightExpect(
        page.getByText(
          "Refetched work details must stay expanded while reading above.",
        ),
      ).toHaveCount(0);
    },
    60_000,
  );

  it(
    "reloads isolated iPad Notes, Mac Code, and iPhone root-thread sessions",
    async () => {
      const launchProfile = async (
        profile: string,
        width: number,
        height: number,
      ) => {
        app = await electron.launch({
          args: [path.resolve(testDirectory, "../.vite/build/main.js")],
          env: {
            ...process.env,
            WEAVE_DESKTOP_SERVER_URL: serverUrl,
            WEAVE_DESKTOP_USER_DATA: path.join(userDataPath, profile),
            WEAVE_PORTAL_HOME: path.join(userDataPath, profile, "portal"),
            WEAVE_AUTH_TOKEN: "",
          },
        });
        const page = await app.firstWindow();
        await app.evaluate(({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
        }, { width, height });
        await page.setViewportSize({ width, height });
        await page.waitForLoadState("domcontentloaded");
        const authToken = page.getByLabel("Auth token");
        const header = page.locator("header").first();
        const initialSurface = await Promise.race([
          authToken.waitFor({ timeout: 10_000 }).then(() => "auth" as const),
          header.waitFor({ timeout: 10_000 }).then(() => "shell" as const),
        ]);
        if (initialSurface === "auth") {
          await authToken.fill("test-token");
          await page.getByRole("button", { name: "Save" }).click();
        }
        await header.waitFor({ timeout: 10_000 });
        return page;
      };
      const closeProfile = async () => {
        await app?.close();
        app = undefined;
      };
      const openSidebar = async (
        page: Awaited<ReturnType<typeof launchProfile>>,
      ) => {
        const sidebar = page.locator("[data-weave-thread-sidebar]");
        if (!(await sidebar.isVisible())) {
          await page.getByRole("button", { name: "Show sidebar" }).first()
            .click();
          await sidebar.waitFor({ timeout: 5_000 });
        }
        return sidebar;
      };

      let page = await launchProfile("ipad-notes", 820, 1180);
      let sidebar = await openSidebar(page);
      await sidebar.getByRole("button", {
        name: "Select Smoke Notes",
        exact: true,
      }).click({ force: true });
      await playwrightExpect(page.locator("header").first()).toContainText(
        "Smoke Notes",
      );
      await closeProfile();

      page = await launchProfile("mac-code", 1440, 900);
      sidebar = await openSidebar(page);
      await sidebar.getByRole("button", { name: /main/ }).first().click({
        force: true,
      });
      await playwrightExpect(page.locator("header").first()).toContainText(
        "Smoke Code",
      );
      await playwrightExpect(
        page.locator("header").first().getByRole("button", {
          name: "Hide chat",
        }),
      ).toHaveCount(0);
      await closeProfile();

      page = await launchProfile("iphone-thread", 430, 900);
      sidebar = await openSidebar(page);
      await sidebar.getByRole("button", { name: /^Loose thought$/ }).click({
        force: true,
      });
      await playwrightExpect(page.locator("header").first()).toContainText(
        "Loose thought",
      );
      await closeProfile();

      page = await launchProfile("ipad-notes", 820, 1180);
      await playwrightExpect(page.locator("header").first()).toContainText(
        "Smoke Notes",
        { timeout: 5_000 },
      );
      await playwrightExpect(
        page.locator("header").first().getByRole("button", {
          name: "Hide notes",
        }),
      ).toBeVisible();
      await closeProfile();

      page = await launchProfile("mac-code", 1440, 900);
      await playwrightExpect(page.locator("header").first()).toContainText(
        "Smoke Code",
        { timeout: 5_000 },
      );
      await playwrightExpect(
        page.locator("header").first().getByRole("button", {
          name: "Hide editor",
        }),
      ).toBeVisible();
      await playwrightExpect(
        page.locator("header").first().getByRole("button", {
          name: "Hide chat",
        }),
      ).toHaveCount(0);
      await closeProfile();

      page = await launchProfile("iphone-thread", 430, 900);
      await playwrightExpect(page.locator("header").first()).toContainText(
        "Loose thought",
        { timeout: 5_000 },
      );
      await playwrightExpect(
        page.locator('[data-weave-active-thread="true"] textarea'),
      ).toBeVisible();
      await playwrightExpect(
        page.locator("header").first().getByRole("button", {
          name: "Hide editor",
        }),
      ).toHaveCount(0);
    },
    90_000,
  );
});
