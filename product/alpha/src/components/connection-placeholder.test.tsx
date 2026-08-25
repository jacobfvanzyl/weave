import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AlphaController } from '@/app/alpha-controller';
import { ConnectionPlaceholder } from './connection-placeholder';

const controller = (): AlphaController => ({
  model: {
    platform: 'ios',
    connection: {
      status: 'disconnected',
      hostUrl: '127.0.0.1',
      hostName: '127.0.0.1',
    },
    accessToken: '',
    searchQuery: '',
    projects: [],
    busy: false,
    error: 'Connection failed',
  },
  actions: {
    setHostUrl: vi.fn(),
    setAccessToken: vi.fn(),
    setSearchQuery: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    refresh: vi.fn(),
    createThread: vi.fn(),
    selectThread: vi.fn(),
    sendPrompt: vi.fn(),
    cancelPrompt: vi.fn(),
    respondToPermission: vi.fn(),
    respondToElicitation: vi.fn(),
    setMode: vi.fn(),
    setConfigOption: vi.fn(),
  },
});

describe('ConnectionPlaceholder', () => {
  it('renders the icon, labeled inputs, and Connect button', () => {
    render(<ConnectionPlaceholder controller={controller()} />);

    expect(screen.getByRole('img', { name: 'Weave' })).toBeVisible();
    expect(screen.getByText('Portal URL')).toBeVisible();
    expect(screen.getByLabelText('Portal URL')).toBeVisible();
    expect(screen.getByText('Access token')).toBeVisible();
    expect(screen.getByLabelText('Access token')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveClass('sr-only');
    expect(screen.queryByText('Connect Weave to Portal')).not.toBeInTheDocument();
    expect(screen.queryByText('Required')).not.toBeInTheDocument();
  });
});
