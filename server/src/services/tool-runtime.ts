import { PostgresServiceBindingRepository } from './bindings';
import { PortalProvider } from './providers/portal-provider';
import { StubProvider } from './providers/stub-providers';
import { DefaultToolService } from './tool-service';

export const toolService = new DefaultToolService(
  new PostgresServiceBindingRepository(),
  {
    portal: new PortalProvider(),
    client: new StubProvider('client'),
    server: new StubProvider('server'),
    external: new StubProvider('external'),
  },
);
