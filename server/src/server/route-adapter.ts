import type { Handler } from 'hono';
import type { WeaveApp } from './types';

export type LegacyRoute = {
  path: string;
  method: string;
  handler?: unknown;
};

type MountRouteOptions = {
  canonicalPath?: string;
  compatibility?: boolean;
};

type RouteHandler = (c: any) => unknown;

const normalizeMethod = (method: string) => method.toUpperCase();

export const defineRoute = (
  path: string,
  options: { method: string; handler?: RouteHandler; [key: string]: unknown },
): LegacyRoute => ({
  path,
  method: options.method,
  handler: options.handler,
});

export const mountRoute = (app: WeaveApp, route: LegacyRoute, options: MountRouteOptions = {}) => {
  const path = options.canonicalPath ?? route.path;
  const handler = route.handler;
  if (!handler) throw new Error(`Route is missing handler: ${route.method} ${route.path}`);
  app.on(normalizeMethod(route.method) as never, path, handler as Handler);
};

export const mountRoutes = (
  app: WeaveApp,
  routes: LegacyRoute[],
  mapPath: (path: string) => string | undefined,
) => {
  for (const route of routes) {
    const canonicalPath = mapPath(route.path);
    if (canonicalPath) mountRoute(app, route, { canonicalPath });
    mountRoute(app, route, { compatibility: true });
  }
};

export const replacePrefix = (path: string, from: string, to: string) =>
  path === from ? to : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : undefined;
