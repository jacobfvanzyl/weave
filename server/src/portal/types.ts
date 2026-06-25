import type {
  getPortalConnection,
  listPortalConnections,
  requestPortalTool,
  resolvePortalForTarget,
} from './registry';
import type { registerPortalRoutes } from './routes';

export type PortalCore = {
  registerRoutes: typeof registerPortalRoutes;
  getConnection: typeof getPortalConnection;
  listConnections: typeof listPortalConnections;
  requestTool: typeof requestPortalTool;
  resolveForTarget: typeof resolvePortalForTarget;
};
