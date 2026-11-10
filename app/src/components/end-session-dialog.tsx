import { useEffect, useState } from 'react';
import type { AppController, SessionSummary } from '@/app/app-controller';
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
import { sessionLabel } from '@/session/sessions';

/**
 * Confirms ending a Session (ADR 0031, WVE-203), which is for good: its Host closes the threads
 * open in it and ends its terminals, and forgets its layout. Nothing brings it back; starting
 * something in its directory later makes a new one. The Host refuses while something in it is
 * running, and the dialog says so.
 */
export function EndSessionDialog({ session, controller, onClose, onEnded }: {
  /** The Session to end; none while the dialog is closed. */
  session?: SessionSummary;
  controller: AppController;
  onClose(): void;
  onEnded?(key: string): void;
}) {
  const { model, actions } = controller;
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!session) return;
    setEnding(false);
    setError(undefined);
  }, [session?.key]);
  const open = session ? model.threads.filter(({ key, state }) => session.threads.includes(key) && state !== 'closed').length : 0;
  const end = async () => {
    if (!session || !actions.endSession) return;
    setEnding(true);
    setError(undefined);
    try {
      await actions.endSession(session.key);
      onEnded?.(session.key);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setEnding(false);
    }
  };
  return (
    <AlertDialog open={session !== undefined} onOpenChange={(next) => { if (!next) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>End {session?.name}{session?.git ? ` (${sessionLabel(session)})` : ''}?</AlertDialogTitle>
          <AlertDialogDescription>
            {open > 0 ? `This closes ${open === 1 ? 'its open thread' : `its ${open} open threads`}, ends its terminals` : 'This ends its terminals'} and
            forgets its layout, for good: nothing brings the Session back. Its directory stays{session?.git ? ', and so does its worktree' : ''}; starting
            a thread or terminal there later makes a new Session.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <Button variant='destructive' disabled={ending} onClick={() => void end()}>{ending ? 'Ending…' : 'End Session'}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
