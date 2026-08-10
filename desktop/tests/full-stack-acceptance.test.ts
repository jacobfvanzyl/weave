import { readFile } from "node:fs/promises";
import { expect as playwrightExpect } from "@playwright/test";
import { afterEach, describe, expect, it } from "vitest";
import { FullStackAcceptanceHarness } from "../acceptance/full-stack-harness";

const runAcceptance = process.env.WEAVE_FULL_STACK_ACCEPTANCE === "1";

describe.skipIf(!runAcceptance)(
  "production shell full-stack acceptance",
  () => {
    let harness: FullStackAcceptanceHarness | undefined;

    afterEach(async () => {
      await harness?.stop();
    });

    it(
      "converges two Desktop clients and retains durable and Portal state across a server restart",
      async () => {
        harness = await FullStackAcceptanceHarness.start();
        const portal = await harness.startPortal();
        await harness.startPackagedDesktop();

        const { project: chatProject } = await harness.rpc.request(
          "code.project.create",
          {
            name: "Acceptance Chat Project",
            projectKind: "general",
            product: "chat",
          },
        );
        const chatWorkspace = chatProject.workspaces[0];
        expect(chatWorkspace).toBeDefined();
        const { thread: chatThread } = await harness.rpc.request(
          "code.project.threads.create",
          {
            projectId: chatProject.id,
            workspaceId: chatWorkspace!.id,
            threadId: "acceptance-chat-thread",
            title: "Workspace-owned Chat Thread",
            product: "chat",
          },
        );
        expect(chatThread.metadata).toMatchObject({
          projectId: chatProject.id,
          workspaceId: chatWorkspace!.id,
        });

        const { project } = await harness.rpc.request("code.project.create", {
          name: "Acceptance Project",
          projectKind: "git",
          portalId: portal.portalId,
          rootId: "default",
          repoPath: harness.workspacePath,
          product: "code",
        });
        const workspace = project.workspaces[0];
        expect(workspace).toBeDefined();
        const { composition: initialComposition } = await harness.rpc.request(
          "workspace.composition.get",
          { projectId: project.id, workspaceId: workspace!.id },
        );
        const { composition: concurrentComposition } = await harness.rpc
          .request(
            "workspace.composition.get",
            { projectId: project.id, workspaceId: workspace!.id },
          );
        expect(initialComposition).toEqual(concurrentComposition);
        expect(initialComposition).toMatchObject({
          workspaceId: workspace!.id,
          schemaVersion: 1,
          revision: 1,
          defaultPaneType: "editor",
          tabs: [{
            name: "New Tab",
            panes: [],
            layout: { kind: "empty" },
          }],
        });

        await expect(harness.rpc.request("chat.thread.create", {
          threadId: "unowned-thread",
          title: "Must not persist",
          projectId: project.id,
          workspaceId: "workspace-missing",
        })).rejects.toThrow("Workspace was not found.");

        const { thread } = await harness.rpc.request("chat.thread.create", {
          threadId: "acceptance-thread",
          title: "Durable acceptance thread",
          projectId: project.id,
          workspaceId: workspace!.id,
        });

        const [firstClient, secondClient] = await Promise.all([
          harness.launchDesktopClient("first"),
          harness.launchDesktopClient("second"),
        ]);
        for (const client of [firstClient, secondClient]) {
          await playwrightExpect(
            client.page.locator("[data-weave-thread-sidebar]"),
          ).toContainText(project.name);
          await playwrightExpect(
            client.page.locator("[data-weave-thread-sidebar]"),
          ).toContainText(
            "Durable acceptance thread",
          );
          const workspaceTab = client.page.locator(
            `[data-weave-workspace-tab-id="${
              initialComposition.tabs[0]!.tabId
            }"]`,
          );
          await playwrightExpect(workspaceTab).toContainText("New Tab");
          await playwrightExpect(workspaceTab).toHaveAttribute(
            "data-weave-workspace-tab-layout-id",
            initialComposition.tabs[0]!.layout.layoutId,
          );
          await playwrightExpect(
            client.page.locator("[data-weave-main-pane]"),
          ).toHaveCount(0);
        }

        await firstClient.page.getByRole("button", {
          name: "Open menu for Durable acceptance thread",
        }).click();
        await firstClient.page.getByRole("menuitem", { name: "Archive" })
          .click();
        await playwrightExpect.poll(async () => {
          const result = await harness!.rpc.request("chat.thread.list");
          return result.threads.find((candidate) => candidate.id === thread.id)
            ?.metadata?.archived;
        }).toBe(true);

        await secondClient.refreshFromServer();
        await playwrightExpect(
          secondClient.page.locator("[data-weave-thread-sidebar]"),
        ).not.toContainText("Durable acceptance thread");
        await secondClient.page.getByRole("button", { name: "main menu" })
          .click();
        await secondClient.page.getByRole("menuitem", {
          name: "Archived Threads",
        }).click();
        await secondClient.page.getByRole("dialog").getByRole("button", {
          name: "Restore",
        }).click();
        await playwrightExpect.poll(async () => {
          const result = await harness!.rpc.request("chat.thread.list");
          return result.threads.find((candidate) => candidate.id === thread.id)
            ?.metadata?.archived;
        }).not.toBe(true);
        await firstClient.refreshFromServer();

        await harness.writeWorkspaceFile(
          {
            projectId: project.id,
            workspaceId: workspace!.id,
            workspacePath: harness.workspacePath,
          },
          "portal-effect.txt",
          "written through the production Portal",
        );
        expect(
          await readFile(`${harness.workspacePath}/portal-effect.txt`, "utf8"),
        ).toBe(
          "written through the production Portal",
        );

        await harness.restartServer();
        await Promise.all([
          firstClient.refreshFromServer(),
          secondClient.refreshFromServer(),
        ]);

        const { composition: restartedComposition } = await harness.rpc.request(
          "workspace.composition.get",
          { projectId: project.id, workspaceId: workspace!.id },
        );
        expect(restartedComposition).toEqual(initialComposition);

        const persistedThreads = await harness.rpc.request("chat.thread.list");
        expect(persistedThreads.threads).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "unowned-thread" }),
          ]),
        );
        expect(persistedThreads.threads).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: thread.id,
              title: "Durable acceptance thread",
              metadata: expect.objectContaining({
                projectId: project.id,
                workspaceId: workspace!.id,
              }),
            }),
          ]),
        );
        expect(
          await harness.database.scalar(
            "select count(*)::int from weave.product_projects where owner_id = $1 and project_id = $2",
            [harness.ownerId, project.id],
          ),
        ).toBe("1");
        expect(
          await harness.database.scalar(
            "select count(*)::int from weave.workspace_compositions where owner_id = $1 and workspace_id = $2",
            [harness.ownerId, workspace!.id],
          ),
        ).toBe("1");
        for (const client of [firstClient, secondClient]) {
          await playwrightExpect(
            client.page.locator("[data-weave-thread-sidebar]"),
          ).toContainText("Durable acceptance thread");
        }
      },
      180_000,
    );
  },
);
