import type {
  AlphaHostConnection,
  AlphaExecutionContext,
} from "@/app/alpha-controller";
import { ExecutionContextHostDialog } from "@/components/project-host-dialog";

export function CreateThreadDialog({
  workspace,
  connections,
  showHostIdentity,
  open,
  onOpenChange,
  onCreateThread,
}: {
  workspace?: AlphaExecutionContext;
  connections: AlphaHostConnection[];
  showHostIdentity?: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreateThread(executionContextId: string, placementId: string): void;
}) {
  const executionContextId = workspace?.id;
  return (
    <ExecutionContextHostDialog
      workspace={workspace}
      connections={connections}
      showHostIdentity={showHostIdentity}
      open={open}
      description={
        <>Create a new thread for {workspace?.name ?? "this project"} on:</>
      }
      onOpenChange={onOpenChange}
      onSelect={(placement) => {
        if (executionContextId) onCreateThread(executionContextId, placement.id);
      }}
    />
  );
}
