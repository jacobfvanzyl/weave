import type { AppController, ThreadSummary } from '@/app/app-controller';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/** Confirms deleting a thread, from its own menu or its row in the list. */
export function DeleteThreadDialog({ thread, actions, open, onOpenChange, onDeleted }: {
  thread: ThreadSummary;
  actions: AppController['actions'];
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The person confirmed: what showed the thread lets go of it. */
  onDeleted?(): void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {thread.title || 'this thread'}?</AlertDialogTitle>
          <AlertDialogDescription>
            The Host forgets it on every device, and so does its agent if it can. Its turn stops if one is running.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant='destructive' onClick={() => {
            void actions.deleteThread(thread.key);
            onDeleted?.();
          }}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
