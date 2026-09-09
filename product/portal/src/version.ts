import { PORTAL_PROTOCOL_VERSION } from '@weave/product-protocol';
declare const WEAVE_BUILD: { version: string; revision: string; sourceHash: string };
export const hostVersion = {
  product: 'weave-host',
  ...(typeof WEAVE_BUILD === 'undefined' ? { version: '0.1.0-dev', revision: 'working-tree', sourceHash: 'unpackaged' } : WEAVE_BUILD),
  runtime: `bun-${Bun.version}`,
  platform: process.platform,
  arch: process.arch,
  protocolVersion: PORTAL_PROTOCOL_VERSION,
  stateFormat: 1,
};
