import type {
  getPortalConnection,
  listPortalConnections,
  requestPortalTool,
  requestPortalRpc,
  resolvePortalForTarget,
  subscribePortalRpcEvent,
} from './registry';

export type PortalCore = {
  getConnection: typeof getPortalConnection;
  listConnections: typeof listPortalConnections;
  requestTool: typeof requestPortalTool;
  requestRpc: typeof requestPortalRpc;
  subscribeRpcEvent: typeof subscribePortalRpcEvent;
  resolveForTarget: typeof resolvePortalForTarget;
};
