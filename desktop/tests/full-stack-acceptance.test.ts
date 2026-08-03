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

        const { project } = await harness.rpc.request("code.project.create", {
          name: "Acceptance Workspace",
          projectKind: "git",
          portalId: portal.portalId,
          rootId: "default",
          repoPath: harness.workspacePath,
          product: "code",
        });
        const workspace = project.workspaces[0];
        expect(workspace).toBeDefined();

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
        }

        await harness.rpc.request("chat.thread.update", {
          threadId: thread.id,
          title: "Converged after RPC update",
        });
        for (const client of [firstClient, secondClient]) {
          await client.waitUntilConnected();
          await playwrightExpect(
            client.page.locator("[data-weave-thread-sidebar]"),
          ).toContainText(
            "Converged after RPC update",
          );
        }

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
          firstClient.waitUntilConnected(),
          secondClient.waitUntilConnected(),
        ]);

        const persistedThreads = await harness.rpc.request("chat.thread.list");
        expect(persistedThreads.threads).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: thread.id,
              title: "Converged after RPC update",
            }),
          ]),
        );
        expect(
          await harness.database.scalar(
            "select count(*)::int from weave.product_projects where owner_id = $1 and project_id = $2",
            [harness.ownerId, project.id],
          ),
        ).toBe("1");
        for (const client of [firstClient, secondClient]) {
          await playwrightExpect(
            client.page.locator("[data-weave-thread-sidebar]"),
          ).toContainText(
            "Converged after RPC update",
          );
        }
      },
      180_000,
    );
  },
);
