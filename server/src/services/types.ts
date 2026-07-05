export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ServiceCaller = {
  kind: 'ui' | 'agent' | 'workflow' | 'system';
  ownerId: string;
  correlation?: {
    requestId?: string;
    threadId?: string;
    agentRunId?: string;
    workflowRunId?: string;
  };
};

export type ServiceScope = {
  ref: ServiceScopeRef;
};

export type ServiceScopeRef =
  | { kind: 'none' }
  | { kind: 'binding'; bindingId: string }
  | { kind: 'resource'; resourceType: string; resourceId: string }
  | { kind: 'locator'; locatorType: string; value: JsonValue };

export type ServiceOperationKind = 'agent' | 'tool' | 'session' | 'resource' | 'event';

export type ServiceGrant = {
  service: ServiceOperationKind;
  operation?: string;
  scope?: ServiceScope;
};

export type ServiceAuditEvent = {
  id: string;
  service: ServiceOperationKind;
  operation: string;
  caller: ServiceCaller;
  scope: ServiceScope;
  provider?: string;
  status: 'allowed' | 'denied' | 'ok' | 'error';
  message?: string;
  at: string;
};

export type ServiceErrorCode =
  | 'invalid_scope'
  | 'binding_not_found'
  | 'provider_not_found'
  | 'permission_denied'
  | 'provider_offline'
  | 'operation_failed'
  | 'not_implemented';

export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
    readonly status = 500,
    readonly details?: JsonValue,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export type ServiceResult<T> =
  | { ok: true; value: T; audit?: ServiceAuditEvent[] }
  | {
    ok: false;
    error: { code: ServiceErrorCode; message: string; status: number; details?: JsonValue };
    audit?: ServiceAuditEvent[];
  };

export const serviceOk = <T>(value: T, audit?: ServiceAuditEvent[]): ServiceResult<T> => ({ ok: true, value, audit });

export const serviceErrorResult = (error: unknown, audit?: ServiceAuditEvent[]): ServiceResult<never> => {
  if (error instanceof ServiceError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        status: error.status,
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
      audit,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: { code: 'operation_failed', message, status: 500 },
    audit,
  };
};

export const serviceAudit = (input: Omit<ServiceAuditEvent, 'id' | 'at'>): ServiceAuditEvent => ({
  id: `audit_${crypto.randomUUID()}`,
  at: new Date().toISOString(),
  ...input,
});

export const serviceScopeNone = (): ServiceScope => ({ ref: { kind: 'none' } });

export const serviceBindingScope = (bindingId: string): ServiceScope => ({
  ref: { kind: 'binding', bindingId },
});

export const serviceResourceScope = (resourceType: string, resourceId: string): ServiceScope => ({
  ref: { kind: 'resource', resourceType, resourceId },
});

export const serviceLocatorScope = (locatorType: string, value: JsonValue): ServiceScope => ({
  ref: { kind: 'locator', locatorType, value },
});

export const isJsonObject = (value: JsonValue | unknown): value is JsonObject =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

export const callerForOwner = (
  ownerId: string,
  kind: ServiceCaller['kind'] = 'ui',
  correlation?: ServiceCaller['correlation'],
): ServiceCaller => ({
  kind,
  ownerId,
  ...(correlation ? { correlation } : {}),
});
