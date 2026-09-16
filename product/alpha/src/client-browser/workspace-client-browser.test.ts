import { describe, it, expect, vi } from 'vitest';
import { WorkspaceClientBrowser, clientBrowserPaneKey } from './workspace-client-browser';
import type { ClientBrowserPrototypeBridge } from './native-client-browser';
const fixture = () => {
  const bridge = { adopt: vi.fn().mockResolvedValue({ surfaceId: 'native' }), create: vi.fn().mockResolvedValue({ surfaceId: 'native' }), layout: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), list: vi.fn().mockResolvedValue({ panes: [{ surfaceId: 'native', paneKey: clientBrowserPaneKey('host', 'pane') }, { surfaceId: 'other-native', paneKey: clientBrowserPaneKey('other', 'pane') }] }) };
  return { bridge, runtime: new WorkspaceClientBrowser(bridge as unknown as ClientBrowserPrototypeBridge) };
};
describe('Client Browser Workspace ownership', () => {
  it('reattaches by Host and Pane identity independently of Workspace placement', async () => {
    const { runtime, bridge } = fixture();
    await runtime.attach({ hostId: 'host', workspaceId: 'one', paneId: 'pane', initialUrl: 'https://linear.app/' });
    await runtime.detach('native');
    await runtime.attach({ hostId: 'host', workspaceId: 'two', paneId: 'pane', initialUrl: 'https://linear.app/' });
    expect(bridge.create.mock.calls[0]).toEqual(bridge.create.mock.calls[1]);
    expect(bridge.close).not.toHaveBeenCalled();
    expect(bridge.layout).toHaveBeenCalledWith(expect.objectContaining({ surfaceId: 'native', visible: false, blocked: true }));
  });
  it('closes only explicitly confirmed absent identities on the requested Host', async () => {
    const { runtime, bridge } = fixture();
    const closed = vi.fn().mockResolvedValue(['pane']);
    await runtime.reconcile('host', closed);
    expect(closed).toHaveBeenCalledWith(['pane']);
    expect(bridge.close).toHaveBeenCalledExactlyOnceWith({ surfaceId: 'native' });
  });
  it('does not reconcile a popup before its placement request finishes', async () => {
    const { runtime, bridge } = fixture();
    await runtime.adopt('host', 'pane', 'popup-token');
    const closed = vi.fn().mockResolvedValue(['pane']);
    await runtime.reconcile('host', closed);
    expect(closed).not.toHaveBeenCalled(); expect(bridge.close).not.toHaveBeenCalled();
    runtime.placementFinished('host', 'pane'); await runtime.reconcile('host', closed);
    expect(bridge.close).toHaveBeenCalledExactlyOnceWith({ surfaceId: 'native' });
  });
  it('retains native pages when membership is unchanged or a Host cannot answer', async () => {
    const { runtime, bridge } = fixture();
    await runtime.reconcile('host', async () => []);
    await expect(runtime.reconcile('host', async () => { throw new Error('Disconnected'); })).rejects.toThrow('Disconnected');
    expect(bridge.close).not.toHaveBeenCalled();
  });
});
