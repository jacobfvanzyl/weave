export type SimpleAuthUser = {
  id: string;
  name: string;
  role: 'user';
};

export const parseAuthTokens = () => {
  if (process.env.WEAVE_AUTH_TOKENS) {
    return JSON.parse(process.env.WEAVE_AUTH_TOKENS) as Record<string, SimpleAuthUser>;
  }

  const authToken = process.env.WEAVE_AUTH_TOKEN;
  if (!authToken) {
    throw new Error('WEAVE_AUTH_TOKEN or WEAVE_AUTH_TOKENS is required when SimpleAuth is enabled');
  }

  return {
    [authToken]: {
      id: process.env.WEAVE_AUTH_USER_ID ?? 'local-user',
      name: process.env.WEAVE_AUTH_USER_NAME ?? 'Local User',
      role: 'user' as const,
    },
  };
};

export const getAuthUserFromHeader = (authorization: string | undefined | null) => {
  if (!authorization) return null;

  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  return parseAuthTokens()[token] ?? null;
};
