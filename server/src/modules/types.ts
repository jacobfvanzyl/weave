import type { OwnerAuthConfig } from '../owner/auth';
import type { WeaveApp } from '../server/types';
import type { AgentCore } from '../agent';
import type { PortalCore } from '../portal/types';
import type { InternalServices } from '../services';
import type { RpcRouter } from '../rpc/router.ts';

export type ModuleServices = {
  auth: OwnerAuthConfig;
  agent: AgentCore;
  portal: PortalCore;
  internal: InternalServices;
};

export type InternalModuleRequest = (input: {
  path: string;
  method?: string;
  body?: unknown;
}) => Promise<unknown>;

export type RpcModuleServices = ModuleServices & {
  requestModule: InternalModuleRequest;
};

export type ServerModule = {
  id: string;
  registerInternalRoutes?: (app: WeaveApp, services: ModuleServices) => void;
  registerRpc?: (router: RpcRouter, services: RpcModuleServices) => void;
};

export const registerServerInternalRoutes = (
  app: WeaveApp,
  services: ModuleServices,
  modules: ServerModule[],
) => {
  for (const module of modules) module.registerInternalRoutes?.(app, services);
};

export const registerServerRpcModules = (
  router: RpcRouter,
  services: RpcModuleServices,
  modules: ServerModule[],
) => {
  for (const module of modules) module.registerRpc?.(router, services);
};
