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

export function GlobalTopRail({
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
    <header
      data-slot="global-top-rail"
      className="flex h-[var(--rail-height)] w-full shrink-0 items-center border-b border-border bg-title-bar px-2"
    >
      <div className="flex h-full items-center">
        <Button
          type="button"
          size="icon-xs"
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
          <Button size="icon-xs" variant="ghost" aria-label="Archived Threads" title="Archived Threads" onClick={controller.actions.openArchivedThreads}>
            <HugeiconsIcon icon={FileBoxIcon} strokeWidth={2} />
          </Button>
        </>}
      </div>
      <div className='ml-auto flex items-center gap-1'>{dockActions}<ConnectionsButton controller={controller} /></div>
    </header>
  );
}
