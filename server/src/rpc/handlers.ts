import { RpcApplicationError } from '../../../packages/protocol/src/peer.ts';
import { rpcErrorCode } from '../../../packages/protocol/src/schema.ts';
import { ServiceError } from '../services/types.ts';

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const recordParams = (value: unknown) => isRecord(value) ? value : {};

export const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

export const requiredString = (value: unknown, name: string) => {
  const parsed = optionalString(value);
  if (!parsed) {
    throw new RpcApplicationError(rpcErrorCode.invalidParams, `${name} is required.`, {
      code: 'INVALID_PARAMS',
    });
  }
  return parsed;
};

export const mapRpcError = (error: unknown): never => {
  if (error instanceof RpcApplicationError) throw error;
  const status = error instanceof ServiceError
    ? error.status
    : typeof (error as { status?: unknown })?.status === 'number'
    ? (error as { status: number }).status
    : 500;
  const code = status === 401
    ? rpcErrorCode.unauthenticated
    : status === 403
    ? rpcErrorCode.forbidden
    : status === 404
    ? rpcErrorCode.notFound
    : status === 409
    ? rpcErrorCode.conflict
    : status >= 400 && status < 500
    ? rpcErrorCode.invalidParams
    : rpcErrorCode.applicationInternal;
  const stableCode = status === 401
    ? 'UNAUTHENTICATED'
    : status === 403
    ? 'FORBIDDEN'
    : status === 404
    ? 'NOT_FOUND'
    : status === 409
    ? 'CONFLICT'
    : status >= 400 && status < 500
    ? 'INVALID_PARAMS'
    : 'INTERNAL';
  throw new RpcApplicationError(code, error instanceof Error ? error.message : String(error), {
    code: stableCode,
    ...(isRecord((error as { details?: unknown })?.details)
      ? { details: (error as { details: Record<string, unknown> }).details }
      : {}),
  });
};

export const guarded = <T>(handler: () => Promise<T> | T): Promise<T> =>
  Promise.resolve().then(handler).catch(mapRpcError);
