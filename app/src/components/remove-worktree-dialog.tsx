import { useEffect, useState } from 'react';
import type { AppController, SessionGit } from '@/app/app-controller';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { directoryName } from '@/lib/display-path';

/**
 * Confirms removing a thread's worktree, from its row in the list. Its open sessions close first, and
 * its branch goes with it when merged. A worktree with changes asks again before they're lost.
 */
export function RemoveWorktreeDialog({ hostId, worktree, actions, open, onOpenChange }: {
  hostId: string;
  /** Where the thread is: its worktree, and the branch that goes too when merged. */
  worktree: SessionGit;
  actions: AppController['actions'];
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const [hasChanges, setHasChanges] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string>();
  const { branch } = worktree;

  useEffect(() => {
    if (!open) return;
    setHasChanges(false);
    setRemoving(false);
    setError(undefined);
  }, [open]);

  const remove = async () => {
    setRemoving(true);
    setError(undefined);
    try {
      const removal = await actions.removeWorktree({ hostId, path: worktree.worktree, force: hasChanges });
      if (removal.outcome === 'hasChanges') {
        setHasChanges(true);
        return;
      }
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {directoryName(worktree.worktree)}?</AlertDialogTitle>
          <AlertDialogDescription>
            {hasChanges
              ? 'It has changes that aren’t committed. Removing it anyway loses them.'
              : `Its directory goes, and its threads close${branch ? `; ${branch} is deleted too if it’s merged` : ''}.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant='destructive' disabled={removing} onClick={() => void remove()}>
            {hasChanges ? 'Remove anyway' : 'Remove'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
