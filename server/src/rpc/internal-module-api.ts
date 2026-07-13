import { Hono } from 'hono';
import type { AgentCore } from '../agent/index.ts';
import type { OwnerAuthConfig } from '../owner/auth.ts';
import { createOwnerAuthMiddleware } from '../owner/auth.ts';
import type { PortalCore } from '../portal/types.ts';
import type { InternalServices } from '../services/index.ts';
import type { ServerVariables } from '../server/types.ts';
import { type InternalModuleRequest, registerServerInternalRoutes, type ServerModule } from '../modules/types.ts';
export type { InternalModuleRequest } from '../modules/types.ts';

export const createInternalModuleApi = (input: {
  auth: OwnerAuthConfig;
  mastra: ServerVariables['mastra'];
  agent: AgentCore;
  portal: PortalCore;
  internal: InternalServices;
  modules: ServerModule[];
}): InternalModuleRequest => {
  const app = new Hono<{ Variables: ServerVariables }>();
  app.use('*', createOwnerAuthMiddleware({ auth: input.auth, mastra: input.mastra }));
  input.agent.registerRoutes(app);
  registerServerInternalRoutes(app, {
    auth: input.auth,
    agent: input.agent,
    portal: input.portal,
    internal: input.internal,
  }, input.modules);
  return async ({ path, method = 'GET', body }) => {
    const response = await app.request(`http://internal.weave${path}`, {
      method,
      headers: {
        authorization: `Bearer ${input.auth.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let result: unknown = text;
    try {
      result = text ? JSON.parse(text) : undefined;
    } catch {
      // Preserve non-JSON diagnostics in the error below.
    }
    if (!response.ok) {
      const message = result && typeof result === 'object' && !Array.isArray(result) &&
          typeof (result as { error?: unknown }).error === 'string'
        ? (result as { error: string }).error
        : text || `Internal module request failed (${response.status}).`;
      const error = new Error(message) as Error & { status: number; details?: unknown };
      error.status = response.status;
      error.details = result;
      throw error;
    }
    return result;
  };
};
