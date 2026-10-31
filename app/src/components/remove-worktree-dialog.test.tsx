import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AppActions, SessionGit } from '@/app/app-controller';
import { RemoveWorktreeDialog } from './remove-worktree-dialog';

const worktree: SessionGit = { repo: '/code/weave', worktree: '/code/weave.feature-auth', branch: 'feature/auth' };

describe('removing a worktree', () => {
  it('asks again before losing its changes, then removes it anyway', async () => {
    const user = userEvent.setup();
    const removeWorktree = vi.fn()
      .mockResolvedValueOnce({ outcome: 'hasChanges' })
      .mockResolvedValueOnce({ outcome: 'removed', branch: 'feature/auth', branchDeleted: false });
    const onOpenChange = vi.fn();
    render(<RemoveWorktreeDialog hostId='h' worktree={worktree} actions={{ removeWorktree } as unknown as AppActions} open onOpenChange={onOpenChange} />);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(/changes that aren’t committed/)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Remove anyway' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(removeWorktree.mock.calls).toEqual([
      [{ hostId: 'h', path: '/code/weave.feature-auth', force: false }],
      [{ hostId: 'h', path: '/code/weave.feature-auth', force: true }],
    ]);
  });
});
