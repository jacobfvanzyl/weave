import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AppActions, AppController, DirectoryListing, PairedHost } from '@/app/app-controller';
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

describe('the new-session dialog', () => {
  it('offers Browse only for a Host that lists its directories', () => {
    const { rerender } = render(<NewSessionDialog controller={controller({ canBrowse: false })} target={{}} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Browse…' })).not.toBeInTheDocument();
    rerender(<NewSessionDialog controller={controller()} target={{ hostId: 'h' }} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Browse…' })).toBeInTheDocument();
  });

  it('browses in, up and among hidden directories, then fills in the one chosen', async () => {
    const user = userEvent.setup();
    const handlers = controller();
    render(<NewSessionDialog controller={handlers} target={{ hostId: 'h', cwd: '/Users/jaco/Projects/weave' }} onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Browse…' }));
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
    expect(screen.getByRole('textbox', { name: 'Directory path' })).toHaveValue('/Users/jaco/Documents');
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(handlers.actions.createSession).toHaveBeenCalledWith({ hostId: 'h', cwd: '/Users/jaco/Documents', agentId: 'claude' });
  });

  it('selects a directory its sessions use already, and opens at home when the typed one can\'t be listed', async () => {
    const user = userEvent.setup();
    render(<NewSessionDialog controller={controller()} target={{ hostId: 'h' }} onClose={() => {}} />);
    await user.selectOptions(screen.getByLabelText('Directory'), 'Another directory…');
    await user.type(screen.getByRole('textbox', { name: 'Directory path' }), '/nowhere');
    await user.click(screen.getByRole('button', { name: 'Browse…' }));
    await waitFor(() => expect(shown()).toHaveTextContent('~'));
    expect(screen.getByText("/nowhere doesn't exist")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Projects' }));
    await user.click(await screen.findByRole('button', { name: 'weave' }));
    await waitFor(() => expect(shown()).toHaveTextContent('~/Projects/weave'));
    await user.click(screen.getByRole('button', { name: 'Use this directory' }));
    expect(screen.getByLabelText('Directory')).toHaveValue('/Users/jaco/Projects/weave');
  });
});

describe('paths under home', () => {
  it('read as ~', () => {
    expect(homePath('/Users/jaco', '/Users/jaco')).toBe('~');
    expect(homePath('/Users/jaco/x', '/Users/jaco')).toBe('~/x');
    expect(homePath('/Users/jacob', '/Users/jaco')).toBe('/Users/jacob');
  });
});
