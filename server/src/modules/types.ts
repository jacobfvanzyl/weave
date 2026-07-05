import type { OwnerAuthConfig } from '../owner/auth';
import type { WeaveApp } from '../server/types';
import type { AgentCore } from '../agent';
import type { PortalCore } from '../portal/types';
import type { InternalServices } from '../services';

export type ModuleServices = {
  auth: OwnerAuthConfig;
  agent: AgentCore;
  portal: PortalCore;
  internal: InternalServices;
};

export type ServerModule = {
  id: string;
  registerRoutes: (app: WeaveApp, services: ModuleServices) => void;
};

export const registerServerModules = (
  app: WeaveApp,
  services: ModuleServices,
  modules: ServerModule[],
) => {
  for (const module of modules) module.registerRoutes(app, services);
};
