import type { Handler } from 'hono';
import type { WeaveApp } from './types';

export type RouteDefinition = {
  path: string;
  method: string;
  handler?: unknown;
};

type MountRouteOptions = {
  canonicalPath?: string;
};

type RouteHandler = (c: any) => unknown;

const normalizeMethod = (method: string) => method.toUpperCase();

export const defineRoute = (
  path: string,
  options: { method: string; handler?: RouteHandler; [key: string]: unknown },
): RouteDefinition => ({
  path,
  method: options.method,
  handler: options.handler,
});

export const mountRoute = (app: WeaveApp, route: RouteDefinition, options: MountRouteOptions = {}) => {
  const path = options.canonicalPath ?? route.path;
  const handler = route.handler;
  if (!handler) throw new Error(`Route is missing handler: ${route.method} ${route.path}`);
  app.on(normalizeMethod(route.method) as never, path, handler as Handler);
};
