export const BROWSER_PROFILES_CAPABILITY = 'browser.profiles.v1';
export const BROWSER_PROFILE_RPC_METHODS = ['browser.profile.list', 'browser.profile.create', 'browser.profile.rename'] as const;
export type BrowserProfileRpcMethod = typeof BROWSER_PROFILE_RPC_METHODS[number];
export type BrowserProfile = { profileId: string; name: string; revision: number; temporary?: true };
export type BrowserProfileRpcContracts = {
  'browser.profile.list': { params: Record<string, never>; result: { profiles: BrowserProfile[] } };
  'browser.profile.create': { params: { name: string }; result: { profile: BrowserProfile } };
  'browser.profile.rename': { params: { profileId: string; name: string; expectedRevision: number }; result: { profile: BrowserProfile } };
};

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Browser Profile object');
  return value as Record<string, unknown>;
};
export function browserProfileId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new Error('Invalid Browser Profile identity');
  return value;
}
export function browserProfileName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid Browser Profile name');
  return value.trim();
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid Browser Profile revision');
  return Number(value);
}
export function parseBrowserProfile(value: unknown): BrowserProfile {
  const input = object(value);
  return { profileId: browserProfileId(input.profileId), name: browserProfileName(input.name), revision: revision(input.revision), ...(input.temporary === true ? { temporary: true as const } : {}) };
}
export function parseBrowserProfileRpcParams<M extends BrowserProfileRpcMethod>(method: M, value: unknown): BrowserProfileRpcContracts[M]['params'] {
  const input = object(value);
  // Profile ownership is Host-wide. Reject old Workspace addressing instead of silently accepting it.
  const keys = method === 'browser.profile.list' ? [] : method === 'browser.profile.create' ? ['name'] : ['profileId', 'name', 'expectedRevision'];
  if (Object.keys(input).some(key => !keys.includes(key))) throw new Error('Unexpected Browser Profile parameter');
  switch (method) {
    case 'browser.profile.list': return {} as BrowserProfileRpcContracts[M]['params'];
    case 'browser.profile.create': return { name: browserProfileName(input.name) } as BrowserProfileRpcContracts[M]['params'];
    case 'browser.profile.rename': return { profileId: browserProfileId(input.profileId), name: browserProfileName(input.name), expectedRevision: revision(input.expectedRevision) } as BrowserProfileRpcContracts[M]['params'];
    default: throw new Error('Unknown Browser Profile operation');
  }
}
export function parseBrowserProfileRpcResult<M extends BrowserProfileRpcMethod>(method: M, value: unknown): BrowserProfileRpcContracts[M]['result'] {
  const input = object(value);
  if (method === 'browser.profile.list') {
    if (!Array.isArray(input.profiles) || input.profiles.length > 320) throw new Error('Invalid Browser Profile list');
    const profiles = input.profiles.map(parseBrowserProfile);
    if (new Set(profiles.map(profile => profile.profileId)).size !== profiles.length) throw new Error('Duplicate Browser Profile identity');
    return { profiles } as BrowserProfileRpcContracts[M]['result'];
  }
  return { profile: parseBrowserProfile(input.profile) } as BrowserProfileRpcContracts[M]['result'];
}
