import type { ServiceCaller, ServiceScope } from '../types';
import { ServiceError } from '../types';

type StubProviderKind = 'client' | 'server' | 'external';

export class StubProvider {
  constructor(readonly kind: StubProviderKind) {}

  resolveTarget(_caller: ServiceCaller, _scope: ServiceScope): never {
    throw new ServiceError('provider_not_found', `${this.kind} provider is not implemented yet.`, 501);
  }

  invokeTool(_input: {
    caller: ServiceCaller;
    scope: ServiceScope;
    toolId: string;
    args: unknown;
    timeoutMs?: number;
  }): never {
    throw new ServiceError('provider_not_found', `${this.kind} tool provider is not implemented yet.`, 501);
  }
}
