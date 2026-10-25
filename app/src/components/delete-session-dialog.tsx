import type { AppController, SessionSummary } from '@/app/app-controller';
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

/** Confirms deleting a session, from its own menu or its row in the list. */
export function DeleteSessionDialog({ session, actions, open, onOpenChange }: {
  session: SessionSummary;
  actions: AppController['actions'];
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {session.title || 'this thread'}?</AlertDialogTitle>
          <AlertDialogDescription>
            The Host forgets it on every device, and so does its agent if it can. Its turn stops if one is running.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant='destructive' onClick={() => void actions.deleteSession(session.key)}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
