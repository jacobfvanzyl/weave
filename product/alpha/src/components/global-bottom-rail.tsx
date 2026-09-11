import { type ReactNode } from "react";
import {
  FileBoxIcon,
  SidebarLeftIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { AlphaController } from "@/app/alpha-controller";
import { ConnectionsButton } from "./connections-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RailDivider } from "./rail-divider";

export function GlobalBottomRail({
  controller,
  dockActions,
  threadsVisible,
  threadsToggleDisabled,
  onToggleThreads,
}: {
  controller: AlphaController;
  dockActions: ReactNode;
  threadsVisible: boolean;
  threadsToggleDisabled: boolean;
  onToggleThreads(): void;
}) {
  return (
    <footer
      data-slot="global-bottom-rail"
      className="flex h-[var(--bottom-rail-height)] w-full shrink-0 items-center border-t border-border bg-status-bar px-4"
    >
      <div className="flex h-full items-center">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Toggle threads"
          aria-pressed={threadsVisible}
          title="Toggle threads"
          className={cn(threadsVisible && "text-primary")}
          disabled={threadsToggleDisabled}
          onClick={onToggleThreads}
        >
          <HugeiconsIcon icon={SidebarLeftIcon} strokeWidth={2} />
        </Button>
        <RailDivider slot="sidebar-rail-divider" />
        {!controller.model.workspaceCompositions && <>
          <Button size="icon" variant="ghost" aria-label="Archived Threads" title="Archived Threads" onClick={controller.actions.openArchivedThreads}>
            <HugeiconsIcon icon={FileBoxIcon} strokeWidth={2} />
          </Button>
          <ConnectionsButton controller={controller} />
        </>}
      </div>
      {dockActions}
    </footer>
  );
}
