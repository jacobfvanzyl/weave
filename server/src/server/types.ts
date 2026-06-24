import type { Mastra } from '@mastra/core/mastra';
import type { RequestContext } from '@mastra/core/request-context';
import type { Owner, OwnerContext } from '../owner/context';

export type ServerVariables = {
  mastra: Mastra;
  owner: Owner;
  ownerContext: OwnerContext;
  requestContext: RequestContext;
};

export type WeaveApp = import('hono').Hono<{ Variables: ServerVariables }>;
