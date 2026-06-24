import { MASTRA_RESOURCE_ID_KEY, RequestContext } from '@mastra/core/request-context';

export type Owner = {
  id: string;
  name: string;
  role: 'owner';
};

export type OwnerContext = {
  owner: Owner;
  mastraResourceId: string;
  requestContext: RequestContext;
};

export const createOwnerRequestContext = (owner: Owner) => {
  const requestContext = new RequestContext();
  requestContext.set(MASTRA_RESOURCE_ID_KEY, owner.id);
  return {
    owner,
    mastraResourceId: owner.id,
    requestContext,
  } satisfies OwnerContext;
};
