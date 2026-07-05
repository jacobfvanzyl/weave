import { LibsqlServiceBindingRepository, type ServiceBindingRepository } from './bindings';
import { DefaultEventService, type EventService } from './event-service';
import { PortalProvider } from './providers/portal-provider';
import { StubProvider } from './providers/stub-providers';
import { DefaultResourceService, type ResourceService } from './resource-service';
import { DefaultSessionService, type SessionService } from './session-service';
import { DefaultToolService, type ToolService } from './tool-service';

export type InternalServices = {
  bindings: ServiceBindingRepository;
  tools: ToolService;
  sessions: SessionService;
  resources: ResourceService;
  events: EventService;
  providers: {
    portal: PortalProvider;
    client: StubProvider;
    server: StubProvider;
    external: StubProvider;
  };
};

export const createInternalServices = (): InternalServices => {
  const bindings = new LibsqlServiceBindingRepository();
  const providers = {
    portal: new PortalProvider(),
    client: new StubProvider('client'),
    server: new StubProvider('server'),
    external: new StubProvider('external'),
  };
  const tools = new DefaultToolService(bindings, providers);
  const sessions = new DefaultSessionService(tools);
  return {
    bindings,
    providers,
    tools,
    sessions,
    resources: new DefaultResourceService(),
    events: new DefaultEventService(),
  };
};

export const internalServices = createInternalServices();

export type { EventService } from './event-service';
export type { ResourceService } from './resource-service';
export type { SessionService } from './session-service';
export type { ToolService } from './tool-service';
export type {
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ServiceAuditEvent,
  ServiceCaller,
  ServiceGrant,
  ServiceScope,
  ServiceScopeRef,
} from './types';
export {
  callerForOwner,
  serviceBindingScope,
  ServiceError,
  serviceLocatorScope,
  serviceResourceScope,
  serviceScopeNone,
} from './types';
export { portalToolScope, type PortalToolTarget, type ResolvedPortalToolTarget } from './providers/portal-provider';
