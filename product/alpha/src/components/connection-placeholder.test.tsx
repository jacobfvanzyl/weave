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
    expect(screen.getByLabelText('Portal URL')).toHaveClass('text-base', 'md:text-xs/relaxed');
    expect(screen.getByText('Access token')).toBeVisible();
    expect(screen.getByLabelText('Access token')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveClass('sr-only');
    expect(screen.queryByText('Connect Weave to Portal')).not.toBeInTheDocument();
    expect(screen.queryByText('Required')).not.toBeInTheDocument();
  });

  it('disables and visually marks the fields while connecting', () => {
    const connecting = controller();
    connecting.model.connection.status = 'connecting';
    connecting.model.accessToken = 'token';
    connecting.model.error = undefined;

    render(<ConnectionPlaceholder controller={connecting} />);

    const portalUrl = screen.getByLabelText('Portal URL');
    const accessToken = screen.getByLabelText('Access token');
    expect(portalUrl).toBeDisabled();
    expect(accessToken).toBeDisabled();
    expect(portalUrl.closest('[data-slot="field"]')).toHaveAttribute('data-disabled', 'true');
    expect(accessToken.closest('[data-slot="field"]')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Connecting to Portal.');
  });
});
