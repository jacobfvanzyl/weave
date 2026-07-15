import { z } from "zod";
import {
  parseRpcNotificationParams,
  parseRpcRequestParams,
  parseRpcRequestResult,
  type RpcNotificationData,
  type RpcNotificationMethod,
  type RpcNotificationParams,
  type RpcRequestMethod,
  type RpcRequestParams,
  type RpcRequestParsedParams,
  type RpcRequestResult,
} from "./contracts.ts";
import { jsonValueSchema } from "./primitives.ts";

const requestIdSchema = z.string().min(1);
const requestOptionsSchema = z.object({
  timeoutMs: z.number().positive().optional(),
}).strict();
const errorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: jsonValueSchema.optional(),
}).strict();

type ClientRequestMethod = RpcRequestMethod<"client", "server">;
type ServerRequestMethod = RpcRequestMethod<"server", "client">;
type ClientNotificationMethod = RpcNotificationMethod<"client", "server">;
type ServerNotificationMethod = RpcNotificationMethod<"server", "client">;

export type DesktopRpcRequestEnvelope<
  Method extends ClientRequestMethod = ClientRequestMethod,
> = Method extends ClientRequestMethod ? {
    kind: "request";
    requestId: string;
    method: Method;
    params: RpcRequestParams<"client", "server", Method>;
    options?: z.infer<typeof requestOptionsSchema>;
  }
  : never;

export type DesktopRpcResponseEnvelope<
  Method extends ClientRequestMethod = ClientRequestMethod,
> = Method extends ClientRequestMethod ?
    | {
      kind: "success";
      requestId: string;
      method: Method;
      result: RpcRequestResult<"client", "server", Method>;
    }
    | {
      kind: "error";
      requestId: string;
      method: Method;
      error: z.infer<typeof errorSchema>;
    }
  : never;

export type DesktopRpcNotificationEnvelope = {
  [Method in ServerNotificationMethod]: {
    kind: "notification";
    method: Method;
    params: RpcNotificationData<"server", "client", Method>;
  };
}[ServerNotificationMethod];

export type DesktopRpcNotifyEnvelope<
  Method extends ClientNotificationMethod = ClientNotificationMethod,
> = Method extends ClientNotificationMethod ? {
    kind: "notification";
    method: Method;
    params: RpcNotificationParams<"client", "server", Method>;
  }
  : never;

export type DesktopRpcReverseRequestEnvelope = {
  [Method in ServerRequestMethod]: {
    kind: "reverse-request";
    requestId: string;
    method: Method;
    params: RpcRequestParsedParams<"server", "client", Method>;
  };
}[ServerRequestMethod];

export type DesktopRpcReverseResponseEnvelope<
  Method extends ServerRequestMethod = ServerRequestMethod,
> = Method extends ServerRequestMethod ?
    | {
      kind: "reverse-success";
      requestId: string;
      method: Method;
      result: RpcRequestResult<"server", "client", Method>;
    }
    | {
      kind: "reverse-error";
      requestId: string;
      method: Method;
      error: z.infer<typeof errorSchema>;
    }
  : never;

const requestEnvelopeBaseSchema = z.object({
  kind: z.literal("request"),
  requestId: requestIdSchema,
  method: z.string().min(1),
  params: z.unknown(),
  options: requestOptionsSchema.optional(),
}).strict();
const responseEnvelopeBaseSchema = z.union([
  z.object({
    kind: z.literal("success"),
    requestId: requestIdSchema,
    method: z.string().min(1),
    result: z.unknown(),
  }).strict(),
  z.object({
    kind: z.literal("error"),
    requestId: requestIdSchema,
    method: z.string().min(1),
    error: errorSchema,
  }).strict(),
]);
const notificationEnvelopeBaseSchema = z.object({
  kind: z.literal("notification"),
  method: z.string().min(1),
  params: z.unknown(),
}).strict();
const reverseRequestEnvelopeBaseSchema = z.object({
  kind: z.literal("reverse-request"),
  requestId: requestIdSchema,
  method: z.string().min(1),
  params: z.unknown(),
}).strict();
const reverseResponseEnvelopeBaseSchema = z.union([
  z.object({
    kind: z.literal("reverse-success"),
    requestId: requestIdSchema,
    method: z.string().min(1),
    result: z.unknown(),
  }).strict(),
  z.object({
    kind: z.literal("reverse-error"),
    requestId: requestIdSchema,
    method: z.string().min(1),
    error: errorSchema,
  }).strict(),
]);

const assertExpectedMethod = (actual: string, expected?: string) => {
  if (expected !== undefined && actual !== expected) {
    throw new Error(
      `Desktop RPC method mismatch: expected ${expected}, received ${actual}.`,
    );
  }
};

export const parseDesktopRpcRequestEnvelope = <
  Method extends ClientRequestMethod = ClientRequestMethod,
>(
  value: unknown,
  expectedMethod?: Method,
): DesktopRpcRequestEnvelope<Method> => {
  const envelope = requestEnvelopeBaseSchema.parse(value);
  assertExpectedMethod(envelope.method, expectedMethod);
  const params = parseRpcRequestParams(
    "client",
    "server",
    envelope.method,
    envelope.params,
  );
  return {
    ...envelope,
    method: envelope.method as Method,
    params,
  } as DesktopRpcRequestEnvelope<Method>;
};

export const parseDesktopRpcResponseEnvelope = <
  Method extends ClientRequestMethod = ClientRequestMethod,
>(
  value: unknown,
  expectedMethod?: Method,
): DesktopRpcResponseEnvelope<Method> => {
  const envelope = responseEnvelopeBaseSchema.parse(value);
  assertExpectedMethod(envelope.method, expectedMethod);
  if (envelope.kind === "error") {
    return envelope as DesktopRpcResponseEnvelope<Method>;
  }
  const result = parseRpcRequestResult(
    "client",
    "server",
    envelope.method,
    envelope.result,
  );
  return {
    ...envelope,
    method: envelope.method as Method,
    result,
  } as DesktopRpcResponseEnvelope<Method>;
};

export const parseDesktopRpcNotificationEnvelope = (
  value: unknown,
): DesktopRpcNotificationEnvelope => {
  const envelope = notificationEnvelopeBaseSchema.parse(value);
  const params = parseRpcNotificationParams(
    "server",
    "client",
    envelope.method,
    envelope.params,
  );
  return {
    ...envelope,
    method: envelope.method as ServerNotificationMethod,
    params,
  } as DesktopRpcNotificationEnvelope;
};

export const parseDesktopRpcNotifyEnvelope = <
  Method extends ClientNotificationMethod = ClientNotificationMethod,
>(
  value: unknown,
  expectedMethod?: Method,
): DesktopRpcNotifyEnvelope<Method> => {
  const envelope = notificationEnvelopeBaseSchema.parse(value);
  assertExpectedMethod(envelope.method, expectedMethod);
  const params = parseRpcNotificationParams(
    "client",
    "server",
    envelope.method,
    envelope.params,
  );
  return {
    ...envelope,
    method: envelope.method as Method,
    params,
  } as DesktopRpcNotifyEnvelope<Method>;
};

export const parseDesktopRpcReverseRequestEnvelope = (
  value: unknown,
): DesktopRpcReverseRequestEnvelope => {
  const envelope = reverseRequestEnvelopeBaseSchema.parse(value);
  const params = parseRpcRequestParams(
    "server",
    "client",
    envelope.method,
    envelope.params,
  );
  return {
    ...envelope,
    method: envelope.method as ServerRequestMethod,
    params,
  } as DesktopRpcReverseRequestEnvelope;
};

export const parseDesktopRpcReverseResponseEnvelope = <
  Method extends ServerRequestMethod = ServerRequestMethod,
>(
  value: unknown,
  expectedMethod?: Method,
): DesktopRpcReverseResponseEnvelope<Method> => {
  const envelope = reverseResponseEnvelopeBaseSchema.parse(value);
  assertExpectedMethod(envelope.method, expectedMethod);
  if (envelope.kind === "reverse-error") {
    return envelope as DesktopRpcReverseResponseEnvelope<Method>;
  }
  const result = parseRpcRequestResult(
    "server",
    "client",
    envelope.method,
    envelope.result,
  );
  return {
    ...envelope,
    method: envelope.method as Method,
    result,
  } as DesktopRpcReverseResponseEnvelope<Method>;
};
