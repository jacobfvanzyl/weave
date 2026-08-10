import type { WorkspaceComposition } from '@weave/protocol';

type WorkspaceTabStripProps = {
  activeTabId: string;
  composition: WorkspaceComposition;
};

export const WorkspaceTabStrip = ({ activeTabId, composition }: WorkspaceTabStripProps) => (
  <nav
    aria-label="Workspace Tabs"
    className="flex min-w-0 shrink-0 overflow-x-auto border-b border-border bg-muted/20 px-2 pt-1"
    data-weave-composition-revision={composition.revision}
    data-weave-composition-schema-version={composition.schemaVersion}
    data-weave-workspace-id={composition.workspaceId}
  >
    <ol className="flex min-w-max items-end gap-1">
      {composition.tabs.map((tab) => (
        <li key={tab.tabId}>
          <span
            aria-current={tab.tabId === activeTabId ? 'page' : undefined}
            className="block rounded-t-md border border-b-0 border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground"
            data-weave-workspace-tab-id={tab.tabId}
            data-weave-workspace-tab-layout-id={tab.layout.layoutId}
            tabIndex={0}
          >
            {tab.name}
          </span>
        </li>
      ))}
    </ol>
  </nav>
);
