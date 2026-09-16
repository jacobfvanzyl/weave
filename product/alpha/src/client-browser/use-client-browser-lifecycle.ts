import { useEffect, useRef } from 'react';
import { paneTargets } from '@weave/product-protocol';
import type { AlphaController } from '@/app/alpha-controller';
import { clientBrowserAvailable, clientBrowserPrototype } from './native-client-browser';
import { readClientBrowserPaneKey, workspaceClientBrowser } from './workspace-client-browser';

export function useClientBrowserLifecycle(controller: AlphaController, report: (message: string) => void) {
  const latest = useRef({ controller, report }); latest.current = { controller, report };
  useEffect(() => {
    if (!clientBrowserAvailable) return;
    let disposed = false, reconciling = false;
    const fail = (error: unknown) => { if (!disposed) latest.current.report(error instanceof Error ? error.message : String(error)); };
    const listener = clientBrowserPrototype.addListener('event', event => {
      if (!['popup-created', 'page-close'].includes(event.kind)) return;
      void (async () => {
        const { panes } = await clientBrowserPrototype.list();
        const entry = panes.find(pane => pane.surfaceId === event.surfaceId);
        const target = entry && readClientBrowserPaneKey(entry.paneKey);
        if (!target || disposed) return;
        const { controller } = latest.current;
        const workspace = controller.model.workspaceCompositions?.compositions[target.hostId]?.workspaces.find(workspace => paneTargets([workspace]).some(pane => pane.paneId === target.paneId));
        if (!workspace) return;
        const reference = { hostId: target.hostId, workspaceId: workspace.workspaceId };
        if (event.kind === 'popup-created' && typeof event.popupToken === 'string') await controller.actions.newClientBrowserPane?.(reference, 'about:blank', { paneId: crypto.randomUUID(), token: event.popupToken, sourcePaneId: target.paneId });
        else if (event.kind === 'page-close') await controller.actions.closeClientBrowserPane?.(reference, target.paneId);
      })().catch(fail);
    });
    const reconcile = async () => {
      if (reconciling || disposed) return; reconciling = true;
      try {
        const { controller } = latest.current;
        for (const connection of controller.model.connections) {
          if (connection.status !== 'connected') continue;
          const client = controller.browserClient?.(connection.hostId);
          if (!client) continue;
          const closed = await workspaceClientBrowser.reconcile(connection.hostId, async paneIds => (await client.browserRequest('client-browser.pane.reconcile', { hostId: connection.hostId, paneIds })).closedPaneIds);
          if (closed) await controller.workspaceActions?.refresh();
        }
      } catch (cause) { fail(cause); }
      finally { reconciling = false; }
    };
    void reconcile(); const timer = setInterval(() => void reconcile(), 1000);
    return () => { disposed = true; clearInterval(timer); void listener.then(handle => handle.remove()); };
  }, []);
}
