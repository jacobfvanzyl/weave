import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceTabStrip } from "../../packages/client/src/components/workspace/WorkspaceTabStrip";

describe("WorkspaceTabStrip", () => {
  it("renders the server-backed composition identity and revision", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceTabStrip
        activeTabId="tab-1"
        composition={{
          workspaceId: "workspace-1",
          schemaVersion: 1,
          revision: 4,
          defaultPaneType: "editor",
          tabs: [{
            tabId: "tab-1",
            name: "New Tab",
            layout: { kind: "empty", layoutId: "layout-1" },
            panes: [],
          }],
        }}
      />,
    );

    expect(markup).toContain('aria-label="Workspace Tabs"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('data-weave-workspace-tab-id="tab-1"');
    expect(markup).toContain('data-weave-composition-schema-version="1"');
    expect(markup).toContain('data-weave-composition-revision="4"');
    expect(markup).toContain("New Tab");
  });
});
