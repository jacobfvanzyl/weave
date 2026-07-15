import type { Context, MiddlewareHandler } from 'hono';
import type { Owner } from './context';
import { createOwnerRequestContext } from './context';
import type { ServerVariables } from '../server/types';

export type OwnerAuthConfig = {
  token: string;
  owner: Owner;
};

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const ownerFromLegacyTokenMap = (rawTokens: string | undefined) => {
  const raw = optionalString(rawTokens);
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('WEAVE_AUTH_TOKENS must be valid JSON or replaced with WEAVE_OWNER_TOKEN.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('WEAVE_AUTH_TOKENS must be an object token map or replaced with WEAVE_OWNER_TOKEN.');
  }

  const entries = Object.entries(parsed).flatMap(([token, user]) => {
    const trimmedToken = optionalString(token);
    if (!trimmedToken) return [];
    const record = user && typeof user === 'object' ? user as Record<string, unknown> : {};
    return [{
      token: trimmedToken,
      ownerId: optionalString(record.id),
      ownerName: optionalString(record.name),
    }];
  });

  if (entries.length !== 1) {
    throw new Error('WEAVE_AUTH_TOKENS is unsupported for multiple tokens. Set one WEAVE_OWNER_TOKEN instead.');
  }

  return entries[0];
};

export const loadOwnerAuthConfig = (env: Record<string, string | undefined> = process.env): OwnerAuthConfig => {
  const directToken = optionalString(env.WEAVE_OWNER_TOKEN) ?? optionalString(env.WEAVE_AUTH_TOKEN);
  const legacyOwner = directToken ? undefined : ownerFromLegacyTokenMap(env.WEAVE_AUTH_TOKENS);
  const token = directToken ?? legacyOwner?.token;

  if (!token) {
    throw new Error('WEAVE_OWNER_TOKEN or WEAVE_AUTH_TOKEN is required.');
  }

  return {
    token,
    owner: {
      id: optionalString(env.WEAVE_OWNER_ID) ?? optionalString(env.WEAVE_AUTH_USER_ID) ?? legacyOwner?.ownerId ??
        'local-user',
      name: optionalString(env.WEAVE_OWNER_NAME) ?? optionalString(env.WEAVE_AUTH_USER_NAME) ??
        legacyOwner?.ownerName ?? 'Local User',
      role: 'owner',
    },
  };
};

export const bearerTokenFromHeader = (authorization: string | undefined | null) => {
  const token = authorization?.replace(/^Bearer\s+/i, '').trim();
  return token || undefined;
};

export const resolveOwnerFromHeader = (
  authorization: string | undefined | null,
  config = loadOwnerAuthConfig(),
) => bearerTokenFromHeader(authorization) === config.token ? config.owner : undefined;

export const createOwnerAuthMiddleware = (
  input: {
    auth: OwnerAuthConfig;
    mastra: ServerVariables['mastra'];
  },
): MiddlewareHandler<{ Variables: ServerVariables }> =>
async (c, next) => {
  const owner = resolveOwnerFromHeader(c.req.header('Authorization'), input.auth);
  if (!owner) return c.json({ error: 'Unauthorized' }, 401);

  const ownerContext = createOwnerRequestContext(owner);
  c.set('owner', owner);
  c.set('ownerContext', ownerContext);
  c.set('requestContext', ownerContext.requestContext);
  c.set('mastra', input.mastra);
  await next();
};

export const ownerResponse = (owner: Owner) => ({
  owner: { id: owner.id, name: owner.name },
});

export const getOwner = (c: Context<{ Variables: ServerVariables }>) => c.get('owner');
