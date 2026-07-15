import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebTerminalTransport } from '../../packages/client/src/lib/terminal-transport';
import type { TerminalTargetInput } from '../../packages/client/src/lib/terminal-types';

describe('terminal transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes close through the target connection when no terminal session connection exists', async () => {
    const rpcRequest = vi.fn(async (request: { requestId: string; method: string }) => ({
      kind: 'success' as const,
      requestId: request.requestId,
      method: request.method,
      result: { ok: true },
    }));
    vi.stubGlobal('window', { weaveDesktop: { rpcRequest } });

    const target: TerminalTargetInput = {
      kind: 'workspace',
      terminalId: 'terminal-1',
      portalId: 'portal-1',
      rootId: 'root-1',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      workspacePath: '/repo/workspace',
    };

    const transport = createWebTerminalTransport();
    await transport?.close('terminal-1', target);

    expect(rpcRequest).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'request',
      method: 'terminal.close',
      params: {
        ...target,
        sessionId: 'terminal-1',
        terminalId: 'terminal-1',
      },
    }));
  });

  it('does not send a terminal RPC for an unscoped close', async () => {
    const rpcRequest = vi.fn(async (request: { requestId: string; method: string }) => ({
      kind: 'success' as const,
      requestId: request.requestId,
      method: request.method,
      result: { ok: true },
    }));
    vi.stubGlobal('window', { weaveDesktop: { rpcRequest } });

    const transport = createWebTerminalTransport();
    await transport?.close('terminal-1');

    expect(rpcRequest).toHaveBeenCalledTimes(0);
  });
});
