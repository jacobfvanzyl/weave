import { type BrowserProfileRpcMethod, type BrowserProfileRpcContracts, parseBrowserProfileRpcParams, parseBrowserProfileRpcResult } from '@weave/product-protocol';
import { PortalSecurity, PortalSecurityError, type PortalPrincipal } from './security.ts';

export interface BrowserProfileBackend {
  profile<M extends BrowserProfileRpcMethod>(method: M, params: BrowserProfileRpcContracts[M]['params']): Promise<BrowserProfileRpcContracts[M]['result']>;
}

/** Portal remains the authority; the private Browser Service owns profile persistence. */
export class BrowserProfileAccess {
  constructor(private backend: BrowserProfileBackend, private security: PortalSecurity) {}
  async request<M extends BrowserProfileRpcMethod>(principal: PortalPrincipal, method: M, params: BrowserProfileRpcContracts[M]['params']): Promise<BrowserProfileRpcContracts[M]['result']> {
    const input = parseBrowserProfileRpcParams(method, params);
    await this.security.assertActive(principal);
    if (method === 'browser.profile.list') {
      const canManage = this.security.allows(principal, 'browser.profile.manage');
      if (!canManage && !principal.grants.actions.includes('browser.profile.inspect') && !principal.grants.actions.includes('browser.profile.control')) throw new PortalSecurityError('RESOURCE_UNAVAILABLE', 'Resource is unavailable.');
      const result = parseBrowserProfileRpcResult('browser.profile.list', await this.backend.profile('browser.profile.list', {}));
      await this.security.assertActive(principal);
      return { profiles: result.profiles.filter(profile => this.security.allows(principal, 'browser.profile.manage') || this.security.allows(principal, 'browser.profile.inspect', { browserProfileId: profile.profileId }) || this.security.allows(principal, 'browser.profile.control', { browserProfileId: profile.profileId })) } as BrowserProfileRpcContracts[M]['result'];
    }
    // Management changes metadata only; it does not grant signed-in browser identity access.
    await this.security.authorize(principal, 'browser.profile.manage');
    const result = await this.backend.profile(method, input);
    await this.security.authorize(principal, 'browser.profile.manage');
    return parseBrowserProfileRpcResult(method, result);
  }
}
