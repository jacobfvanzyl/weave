import { useEffect, useState } from 'react';
import type { AppActions, RepositoryListing, WorktreeSummary } from '@/app/app-controller';

/** The chosen directory itself, in the worktree it's in. */
const HERE = '\u0000here';

/** How long typing a directory waits before asking whether it's in a repository. */
const LOOKUP_DELAY_MS = 300;

/** The worktree `cwd` is in: the deepest one whose directory holds it. */
const containing = (repository: RepositoryListing, cwd: string) =>
  repository.worktrees
    .filter(({ path }) => cwd === path || cwd.startsWith(`${path}/`))
    .sort((left, right) => right.path.length - left.path.length)[0];

/**
 * Which worktree something new starts in: the directory chosen, or another worktree of the
 * repository it's in, on a Host that manages worktrees, or one made for a branch. The repository
 * is asked for again whenever the Host or the directory changes, while `on`.
 */
export function useWorktreeChoice({ actions, on, hostId, cwd, canWorktree, immediate }: {
  actions: Pick<AppActions, 'listWorktrees' | 'createWorktree'>;
  /** Whether the dialog asking is open. */
  on: boolean;
  hostId: string;
  cwd: string;
  canWorktree: boolean;
  /** The directory was picked, not typed, so there's nothing to wait for. */
  immediate: boolean;
}) {
  // The repository the directory is in, once the Host has said.
  const [repository, setRepository] = useState<RepositoryListing>();
  const [place, setPlace] = useState(HERE);

  useEffect(() => {
    setRepository(undefined);
    setPlace(HERE);
    if (!on || !canWorktree || !cwd.startsWith('/')) return;
    let current = true;
    const lookup = setTimeout(() => {
      actions.listWorktrees({ hostId, path: cwd }).then(
        (found) => { if (current) setRepository(found); },
        // Worktrees are on offer only when the Host can list them; the directory still works.
        () => {},
      );
    }, immediate ? 0 : LOOKUP_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(lookup);
    };
  }, [on, hostId, cwd, canWorktree]);

  const here = repository && containing(repository, cwd);
  const chosen: WorktreeSummary | undefined = repository && (place === HERE ? here : repository.worktrees.find(({ path }) => path === place));
  return {
    repository,
    /** The worktree chosen; none outside a repository, or in a directory no worktree holds. */
    chosen,
    /** Where it starts: the worktree picked, else the directory itself. */
    directory: repository && place !== HERE ? place : cwd,
    choose: (path: string) => setPlace(path === here?.path ? HERE : path),
    async create({ branch, base }: { branch: string; base?: string }) {
      const path = await actions.createWorktree({ hostId, repo: cwd, branch, ...(base ? { base } : {}) });
      const made: WorktreeSummary = { path, branch, primary: false, changes: false, threads: [] };
      setRepository((listed) => listed && { ...listed, worktrees: [...listed.worktrees, made] });
      return path;
    },
  };
}
