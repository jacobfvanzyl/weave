import type {
  AlphaHostConnection,
  AlphaWorkspace,
} from "@/app/alpha-controller";
import { ProjectHostDialog } from "@/components/project-host-dialog";

export function CreateThreadDialog({
  workspace,
  connections,
  open,
  onOpenChange,
  onCreateThread,
}: {
  workspace?: AlphaWorkspace;
  connections: AlphaHostConnection[];
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreateThread(workspaceId: string, placementId: string): void;
}) {
  const workspaceId = workspace?.id;
  return (
    <ProjectHostDialog
      workspace={workspace}
      connections={connections}
      open={open}
      description={
        <>Create a new thread for {workspace?.name ?? "this project"} on:</>
      }
      onOpenChange={onOpenChange}
      onSelect={(placement) => {
        if (workspaceId) onCreateThread(workspaceId, placement.id);
      }}
    />
  );
}
