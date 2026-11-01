import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { McpServerStatus } from '@/host/protocol';
import { ThreadStatusSheet } from './thread-status-sheet';

const servers: McpServerStatus[] = [
  { name: 'weave', source: 'host', transport: 'acp', state: 'connected' },
  { name: 'github', source: 'config', transport: 'stdio', state: 'passed' },
  { name: 'docs', source: 'config', state: 'skipped', reason: 'the agent does not support the sse transport' },
];

const sheet = (props: Partial<Parameters<typeof ThreadStatusSheet>[0]>) => render(
  <ThreadStatusSheet open onOpenChange={() => {}} agentListsServers={false} side='right' {...props} />,
);

describe('the thread status sheet', () => {
  it('lists the servers as the Host reports them, with why one was skipped', () => {
    sheet({ servers, agentListsServers: true });
    const rows = within(screen.getByRole('list', { name: 'MCP servers' })).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      "weaveConnected · weave's own · over ACP",
      'githubPassed to the agent · From the config · stdio',
      'docsSkipped · From the config' + 'the agent does not support the sse transport',
    ]);
    expect(rows.map((row) => row.querySelector('[data-tone]')?.getAttribute('data-tone'))).toEqual(['good', 'quiet', 'warning']);
    expect(screen.getByText(/its \/mcp lists them/)).toBeInTheDocument();
  });

  it('says when weave is unavailable, and why', () => {
    sheet({
      servers: [{
        name: 'weave',
        source: 'host',
        transport: 'stdio',
        state: 'unavailable',
        reason: "This agent's MCP client predates MCP 2026-07-28, so it can't use weave's tools.",
      }],
    });
    expect(screen.getByText('Unavailable · weave\'s own · stdio')).toBeInTheDocument();
    expect(screen.getByText(/predates MCP 2026-07-28/)).toBeInTheDocument();
    expect(screen.queryByText(/\/mcp/)).not.toBeInTheDocument();
  });

  it('says when the Host reports none', () => {
    sheet({ servers: undefined });
    expect(screen.getByText(/doesn't report MCP servers/)).toBeInTheDocument();
    sheet({ servers: [] });
    expect(screen.getByText('weave gave the agent none.')).toBeInTheDocument();
  });
});
