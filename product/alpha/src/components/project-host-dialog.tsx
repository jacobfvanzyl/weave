import type { ReactNode } from "react";
import { ComputerIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  AlphaHostConnection,
  AlphaWorkspace,
  AlphaWorkspacePlacement,
} from "@/app/alpha-controller";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function ProjectHostDialog({
  workspace,
  connections,
  open,
  description,
  onOpenChange,
  onSelect,
}: {
  workspace?: AlphaWorkspace;
  connections: AlphaHostConnection[];
  open: boolean;
  description: ReactNode;
  onOpenChange(open: boolean): void;
  onSelect(placement: AlphaWorkspacePlacement): void;
}) {
  const connectionStatus = new Map(
    connections.map(({ hostId, status }) => [hostId, status]),
  );
  const placements =
    workspace?.placements ??
    (workspace
      ? [
          {
            id: `${workspace.hostId}:${workspace.workspaceId}`,
            workspaceId: workspace.workspaceId,
            hostId: workspace.hostId,
            hostName: workspace.hostName,
          },
        ]
      : []);
  const hostPlacements = placements.filter(
    (placement, index) =>
      placements.findIndex(({ hostId }) => hostId === placement.hostId) ===
      index,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Choose a Host</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2" aria-label="Project Hosts">
          {hostPlacements.map((placement) => {
            const status =
              connectionStatus.get(placement.hostId) ?? "disconnected";
            const connected = status === "connected";
            return (
              <Button
                key={placement.id}
                type="button"
                variant="outline"
                className="h-auto justify-start gap-3 p-3 text-left"
                disabled={!connected}
                onClick={() => {
                  onOpenChange(false);
                  onSelect(placement);
                }}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <HugeiconsIcon icon={ComputerIcon} strokeWidth={2} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{placement.hostName}</span>
                  {!connected && (
                    <span className="block capitalize text-muted-foreground">
                      {status}
                    </span>
                  )}
                </span>
              </Button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
