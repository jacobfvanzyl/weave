import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AppActions, AppController, DirectoryListing, PairedHost, RepositoryListing } from '@/app/app-controller';
import { homePath } from './directory-picker';
import { NewSessionDialog } from './new-session-dialog';

const TREE: Record<string, string[]> = {
  '/': ['Users'],
  '/Users': ['jaco'],
  '/Users/jaco': ['.config', 'Documents', 'Projects'],
  '/Users/jaco/Documents': [],
  '/Users/jaco/Projects': ['weave'],
  '/Users/jaco/Projects/weave': [],
};

const listDirectory = vi.fn(async ({ path, hidden }: { hostId: string; path?: string; hidden?: boolean }): Promise<DirectoryListing> => {
  const listed = path ?? '/Users/jaco';
  const directories = TREE[listed];
  if (!directories) throw new Error(`${listed} doesn't exist`);
  const parent = listed === '/' ? undefined : listed.slice(0, listed.lastIndexOf('/')) || '/';
  return {
    path: listed,
    ...(parent ? { parent } : {}),
    home: '/Users/jaco',
    directories: directories.filter((name) => hidden || !name.startsWith('.')),
    truncated: false,
  };
});

const controller = (host: Partial<PairedHost> = {}): AppController => ({
  model: {
    hosts: [{ id: 'h', name: 'mac.example.ts.net', url: 'wss://mac.example.ts.net:7341', status: 'connected', canBrowse: true, ...host }],
    sessions: [{
      key: 'h/s', hostId: 'h', sessionId: 's', agentId: 'claude', agentName: 'Claude', cwd: '/Users/jaco/Projects/weave',
      state: 'open', activity: 'idle', clients: 0, headless: false,
    }],
    agents: { h: [{ id: 'claude', name: 'Claude' }] },
    unread: new Set(),
  },
  actions: { createSession: vi.fn(), listDirectory } as unknown as AppActions,
});

const shown = () => screen.getByText((_, element) => element?.getAttribute('aria-live') === 'polite' && element.tagName === 'P');

const REPOSITORY: RepositoryListing = {
  repo: '/Users/jaco/Projects/weave',
  defaultBranch: 'main',
  worktrees: [
    { path: '/Users/jaco/Projects/weave', branch: 'main', primary: true, changes: false, sessions: ['s'] },
    { path: '/Users/jaco/Projects/weave.review', primary: false, changes: false, sessions: [] },
  ],
};

describe('the new-session dialog in a repository', () => {
  const inRepository = (actions: Partial<AppActions>): AppController => {
    const base = controller({ canWorktree: true });
    return { ...base, actions: { ...base.actions, listWorktrees: vi.fn(async () => REPOSITORY), ...actions } };
  };
  const worktrees = () => within(screen.getByRole('list', { name: 'Worktrees' })).getAllByRole('button');

  it('starts in another of its worktrees, picked from its list', async () => {
    const user = userEvent.setup();
    const handlers = inRepository({});
    render(<NewSessionDialog controller={handlers} target={{ hostId: 'h', cwd: '/Users/jaco/Projects/weave' }} onClose={() => {}} />);
    const field = await screen.findByRole('button', { name: 'Worktree' });
    expect(field).toHaveTextContent('mainweave');
    await user.click(field);
    expect(screen.getByRole('heading', { name: 'Choose a worktree' })).toBeInTheDocument();
    expect(worktrees().map(({ textContent }) => textContent)).toEqual(['mainweave · 1 thread', 'detached HEADweave.review']);
    expect(worktrees()[0]).toHaveAttribute('aria-current', 'true');
    await user.click(worktrees()[1]);
    expect(screen.getByRole('button', { name: 'Worktree' })).toHaveTextContent('detached HEADweave.review');
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(handlers.actions.createSession).toHaveBeenCalledWith({ hostId: 'h', cwd: '/Users/jaco/Projects/weave.review', agentId: 'claude' });
  });

  it('creates a worktree from the picker, saying why when it can\u2019t, and starts there', async () => {
    const user = userEvent.setup();
    const createWorktree = vi.fn()
      .mockRejectedValueOnce(new Error("Couldn't make the worktree: feature/auth is checked out in /x already"))
      .mockResolvedValueOnce('/Users/jaco/Projects/weave.feature-auth');
    const handlers = inRepository({ createWorktree });
    render(<NewSessionDialog controller={handlers} target={{ hostId: 'h', cwd: '/Users/jaco/Projects/weave' }} onClose={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Worktree' }));
    expect(screen.getByRole('button', { name: 'Create worktree' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Start from' })).toHaveAttribute('placeholder', 'Start from main');
    await user.type(screen.getByRole('textbox', { name: 'Branch' }), 'feature/auth');
    await user.type(screen.getByRole('textbox', { name: 'Start from' }), 'v1.2');
    await user.click(screen.getByRole('button', { name: 'Create worktree' }));
    expect(await screen.findByText(/checked out in \/x already/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create worktree' }));
    // Back in the form, with the new worktree chosen.
    const field = await screen.findByRole('button', { name: 'Worktree' });
    expect(field).toHaveTextContent('feature/authweave.feature-auth');
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(createWorktree).toHaveBeenLastCalledWith({ hostId: 'h', repo: '/Users/jaco/Projects/weave', branch: 'feature/auth', base: 'v1.2' });
    expect(handlers.actions.createSession).toHaveBeenCalledWith({ hostId: 'h', cwd: '/Users/jaco/Projects/weave.feature-auth', agentId: 'claude' });
    // It's among the worktrees now.
    await user.click(screen.getByRole('button', { name: 'Worktree' }));
    expect(worktrees().map(({ textContent }) => textContent)).toContain('feature/authweave.feature-auth');
  });

  it('leaves worktrees out for a directory outside a repository', async () => {
    const listWorktrees = vi.fn(async () => undefined);
    render(<NewSessionDialog controller={inRepository({ listWorktrees })} target={{ hostId: 'h', cwd: '/Users/jaco/Documents' }} onClose={() => {}} />);
    await waitFor(() => expect(listWorktrees).toHaveBeenCalledWith({ hostId: 'h', path: '/Users/jaco/Documents' }));
    expect(screen.queryByRole('button', { name: 'Worktree' })).not.toBeInTheDocument();
  });
});

describe('the new-session dialog', () => {
  it('picks the directory by browsing a Host that lists its directories, and takes it typed otherwise', () => {
    const { rerender } = render(<NewSessionDialog controller={controller({ canBrowse: false })} target={{}} onClose={() => {}} />);
    expect(screen.getByRole('textbox', { name: 'Directory' })).toHaveValue('/Users/jaco/Projects/weave');
    rerender(<NewSessionDialog controller={controller()} target={{ hostId: 'h' }} onClose={() => {}} />);
    expect(screen.queryByRole('combobox', { name: 'Directory' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Directory' })).toHaveAttribute('title', '/Users/jaco/Projects/weave');
  });

  it('browses in, up and among hidden directories, then fills in the one chosen', async () => {
    const user = userEvent.setup();
    const handlers = controller();
    render(<NewSessionDialog controller={handlers} target={{ hostId: 'h', cwd: '/Users/jaco/Projects/weave' }} onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Directory' }));
    // It opens where the dialog was.
    await waitFor(() => expect(shown()).toHaveTextContent('~/Projects/weave'));
    await user.click(screen.getByRole('button', { name: 'Up' }));
    await waitFor(() => expect(shown()).toHaveTextContent('~/Projects'));
    await user.click(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(shown()).toHaveTextContent('~'));
    const directories = () => within(screen.getByRole('list', { name: 'Directories' })).getAllByRole('button').map((button) => button.textContent);
    expect(directories()).toEqual(['Documents', 'Projects']);
    await user.click(screen.getByRole('checkbox', { name: 'Show hidden directories' }));
    await waitFor(() => expect(directories()).toEqual(['.config', 'Documents', 'Projects']));
    await user.click(screen.getByRole('button', { name: 'Documents' }));
    await waitFor(() => expect(shown()).toHaveTextContent('~/Documents'));
    expect(screen.getByText('No directories in here.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Use this directory' }));
    expect(screen.getByRole('button', { name: 'Directory' })).toHaveAttribute('title', '/Users/jaco/Documents');
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(handlers.actions.createSession).toHaveBeenCalledWith({ hostId: 'h', cwd: '/Users/jaco/Documents', agentId: 'claude' });
  });

  it('offers the directories its sessions use, and opens at home when the one given can\u2019t be listed', async () => {
    const user = userEvent.setup();
    render(<NewSessionDialog controller={controller()} target={{ hostId: 'h', cwd: '/nowhere' }} onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Directory' }));
    await waitFor(() => expect(shown()).toHaveTextContent('~'));
    expect(screen.getByText("/nowhere doesn't exist")).toBeInTheDocument();
    const recent = within(screen.getByRole('list', { name: 'Recent directories' })).getAllByRole('button');
    expect(recent.map(({ textContent }) => textContent)).toEqual(['weave~/Projects/weave']);
    await user.click(recent[0]);
    expect(screen.getByRole('button', { name: 'Directory' })).toHaveAttribute('title', '/Users/jaco/Projects/weave');
  });
});

describe('paths under home', () => {
  it('read as ~', () => {
    expect(homePath('/Users/jaco', '/Users/jaco')).toBe('~');
    expect(homePath('/Users/jaco/x', '/Users/jaco')).toBe('~/x');
    expect(homePath('/Users/jacob', '/Users/jaco')).toBe('/Users/jacob');
  });
});
