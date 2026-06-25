import type { OwnerAuthConfig } from '../owner/auth';
import type { WeaveApp } from '../server/types';
import type { AgentCore } from '../agent';
import type { PortalCore } from '../portal/types';

export type ModuleServices = {
  auth: OwnerAuthConfig;
  agent: AgentCore;
  portal: PortalCore;
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
