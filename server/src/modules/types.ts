import type { OwnerAuthConfig } from '../owner/auth';
import type { WeaveApp } from '../server/types';

export type ModuleServices = {
  auth: OwnerAuthConfig;
  mastra: import('@mastra/core/mastra').Mastra;
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
