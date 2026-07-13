import {
  getPortalConnection,
  listPortalConnections,
  requestPortalTool,
  requestPortalRpc,
  resolvePortalForTarget,
  subscribePortalRpcEvent,
} from './registry';
import type { PortalCore } from './types';

export const portalCore: PortalCore = {
  getConnection: getPortalConnection,
  listConnections: listPortalConnections,
  requestTool: requestPortalTool,
  requestRpc: requestPortalRpc,
  subscribeRpcEvent: subscribePortalRpcEvent,
  resolveForTarget: resolvePortalForTarget,
};

export {
  getPortalConnection,
  listPortalConnections,
  requestPortalTool,
  requestPortalRpc,
  resolvePortalForTarget,
  subscribePortalRpcEvent,
};
export type { PortalCore };
