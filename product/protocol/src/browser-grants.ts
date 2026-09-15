import { browserProfileId } from './browser-profiles.ts';
export const BROWSER_GRANTS_CAPABILITY = 'browser.grants.v1';
export const BROWSER_GRANT_RPC_METHODS = ['browser.grants.get', 'browser.grants.set'] as const;
export type BrowserGrantRpcMethod = typeof BROWSER_GRANT_RPC_METHODS[number];
export type BrowserThreadGrants = { threadId: string; profileIds: string[]; revision: number };
export type BrowserGrantRpcContracts = {
  'browser.grants.get': { params: { threadId: string }; result: BrowserThreadGrants };
  'browser.grants.set': { params: { threadId: string; profileIds: string[]; expectedRevision: number }; result: BrowserThreadGrants };
};
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid browser grant'); return value as Record<string, unknown>; };
const revision = (value: unknown): number => { if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid grant revision'); return Number(value); };
const profiles = (value: unknown): string[] => { if (!Array.isArray(value) || value.length > 64) throw new Error('Invalid Profile grants'); const ids = value.map(browserProfileId); if (new Set(ids).size !== ids.length) throw new Error('Duplicate Profile grant'); return ids; };
export function parseBrowserGrantRpcParams<M extends BrowserGrantRpcMethod>(method: M, value: unknown): BrowserGrantRpcContracts[M]['params'] {
  const input = object(value), keys = method === 'browser.grants.get' ? ['threadId'] : ['threadId', 'profileIds', 'expectedRevision'];
  if (Object.keys(input).some(key => !keys.includes(key))) throw new Error('Unexpected browser grant parameter');
  const threadId = browserProfileId(input.threadId);
  if (method === 'browser.grants.get') return { threadId } as BrowserGrantRpcContracts[M]['params'];
  if (method !== 'browser.grants.set') throw new Error('Unknown browser grant operation');
  return { threadId, profileIds: profiles(input.profileIds), expectedRevision: revision(input.expectedRevision) } as BrowserGrantRpcContracts[M]['params'];
}
export function parseBrowserThreadGrants(value: unknown): BrowserThreadGrants { const input = object(value); return { threadId: browserProfileId(input.threadId), profileIds: profiles(input.profileIds), revision: revision(input.revision) }; }
