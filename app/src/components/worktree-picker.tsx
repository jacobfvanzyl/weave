import { useState, type FormEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { GitBranchIcon, Tick02Icon } from '@hugeicons/core-free-icons';
import type { RepositoryListing } from '@/app/app-controller';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { directoryName } from '@/lib/display-path';

/**
 * Picks one of a repository's worktrees for a new session, or creates one beside the repository:
 * on a new branch from what it starts from (else the default branch), or on a branch that exists.
 * Creating happens at once, so the worktree is there whether or not the session then starts.
 */
export function WorktreePicker({ repository, selected, create, onChoose, onCancel }: {
  repository: RepositoryListing;
  /** The worktree chosen now, by its path. */
  selected?: string;
  /** Creates the worktree; resolves to its path, or rejects saying why not. */
  create(input: { branch: string; base?: string }): Promise<string>;
  onChoose(path: string): void;
  onCancel(): void;
}) {
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setCreating(true);
    setError(undefined);
    try {
      onChoose(await create({ branch: branch.trim(), ...(base.trim() ? { base: base.trim() } : {}) }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  return (
    <form aria-label='New worktree' className='grid gap-3' data-slot='worktree-picker' onSubmit={submit}>
      <ul aria-label='Worktrees' className='max-h-[min(40vh,18rem)] overflow-y-auto rounded-md border'>
        {repository.worktrees.map((worktree) => {
          const current = worktree.path === selected;
          const sessions = worktree.sessions.length;
          return (
            <li key={worktree.path}>
              <button type='button' aria-current={current ? 'true' : undefined} title={worktree.path}
                className='flex min-h-10 w-full min-w-0 items-center gap-2 px-2.5 text-left text-xs hover:bg-muted aria-[current]:bg-muted'
                onClick={() => onChoose(worktree.path)}>
                <HugeiconsIcon icon={GitBranchIcon} strokeWidth={1.75} className='size-4 shrink-0 text-muted-foreground' />
                <span className='flex min-w-0 flex-1 flex-col'>
                  <span className='truncate font-medium'>{worktree.branch ?? 'detached HEAD'}</span>
                  <span className='truncate text-[0.6875rem] text-muted-foreground'>
                    {[
                      directoryName(worktree.path),
                      worktree.changes && 'changed',
                      sessions > 0 && `${sessions} ${sessions === 1 ? 'session' : 'sessions'}`,
                    ].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {current && <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className='size-4 shrink-0' aria-hidden />}
              </button>
            </li>
          );
        })}
      </ul>
      <div className='grid gap-1.5'>
        <Label htmlFor='worktree-picker-branch'>New worktree</Label>
        <Input id='worktree-picker-branch' aria-label='Branch' autoCapitalize='off' autoCorrect='off' placeholder='Branch, as feature/name'
          value={branch} onChange={(event) => setBranch(event.target.value)} />
        <Input aria-label='Start from' autoCapitalize='off' autoCorrect='off'
          placeholder={repository.defaultBranch ? `Start from ${repository.defaultBranch}` : 'Start from the checkout’s commit'}
          value={base} onChange={(event) => setBase(event.target.value)} />
        <p className='text-[0.6875rem] text-muted-foreground'>
          Beside {directoryName(repository.repo)}, on a new branch, or on the one named if it exists.
        </p>
      </div>
      {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
      <div className='flex justify-end gap-1.5'>
        <Button type='button' variant='ghost' onClick={onCancel}>Back</Button>
        <Button type='submit' disabled={!branch.trim() || creating}>{creating ? 'Creating…' : 'Create worktree'}</Button>
      </div>
    </form>
  );
}
