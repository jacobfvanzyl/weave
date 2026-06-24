import {
  loadOwnerAuthConfig,
  resolveOwnerFromHeader,
} from '../owner/auth';

export type OwnerAuthUser = {
  id: string;
  name: string;
  role: 'user' | 'owner';
};

export const parseAuthTokens = () => {
  const auth = loadOwnerAuthConfig();

  return {
    [auth.token]: {
      id: auth.owner.id,
      name: auth.owner.name,
      role: auth.owner.role,
    },
  };
};

export const getAuthUserFromHeader = (authorization: string | undefined | null) => {
  const owner = resolveOwnerFromHeader(authorization);
  return owner ? { id: owner.id, name: owner.name, role: owner.role } : null;
};
