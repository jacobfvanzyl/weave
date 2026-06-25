import {
  getPortalConnection,
  listPortalConnections,
  requestPortalTool,
  resolvePortalForTarget,
} from './registry';
import { registerPortalRoutes } from './routes';
import type { PortalCore } from './types';

export const portalCore: PortalCore = {
  registerRoutes: registerPortalRoutes,
  getConnection: getPortalConnection,
  listConnections: listPortalConnections,
  requestTool: requestPortalTool,
  resolveForTarget: resolvePortalForTarget,
};

export {
  getPortalConnection,
  listPortalConnections,
  registerPortalRoutes,
  requestPortalTool,
  resolvePortalForTarget,
};
export type { PortalCore };
