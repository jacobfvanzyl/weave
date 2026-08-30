import {
  PORTAL_AUTH_CHALLENGE_TYPE,
  PORTAL_PAIR_RESULT_TYPE,
  PORTAL_PAIRING_TOKEN_ALGORITHM,
  PORTAL_PAIRING_TOKEN_AUDIENCE,
  PORTAL_PAIRING_TOKEN_TYPE,
  type PortalAuthChallenge,
  portalAuthChallengePayload,
  type PortalAuthResponse,
  type PortalPairRequest,
  type PortalPairResult,
  type PortalPrincipalSummary,
} from '@weave/product-protocol';
import { dirname, join } from 'jsr:@std/path@1.1.2';
import type { PortalConfig } from './config.ts';

export const PORTAL_ACTIONS = [
  'portal.inspect',
  'workspace.inspect',
  'workspace.manage',
  'thread.inspect',
  'thread.create',
  'thread.attach',
  'workspace.file.read',
  'workspace.file.write',
  'agent.use',
  'terminal.observe',
  'terminal.control',
  'browser.observe',
  'browser.control',
  'credential.rotate',
  'credential.revoke',
] as const;

export type PortalAction = typeof PORTAL_ACTIONS[number];
export type PortalResource = {
  workspaceId?: string;
  agentId?: string;
  threadId?: string;
  terminalId?: string;
};
export type PortalGrants = {
  actions: PortalAction[];
  workspaceIds: string[];
  agentIds: string[];
};

type StoredCredential = {
  credentialId: string;
  principalId: string;
  label: string;
  publicKey: string;
  status: 'active' | 'pending' | 'revoked';
  grants: PortalGrants;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
  replacesCredentialId?: string;
};

type StoredPairingOffer = {
  offerId: string;
  grants: PortalGrants;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
};

type SecurityState = {
  version: 1;
  hostId: string;
  credentials: StoredCredential[];
  pairingOffers: StoredPairingOffer[];
};

export type PortalPrincipal = PortalPrincipalSummary & {
  grants: PortalGrants;
};

export type PairingTokenClaims = {
  iss: string;
  aud: typeof PORTAL_PAIRING_TOKEN_AUDIENCE;
  jti: string;
  iat: number;
  exp: number;
};

export type SafeCredentialSummary = {
  credentialId: string;
  principalId: string;
  label: string;
  status: StoredCredential['status'];
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
};

export class PortalSecurityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly auditId = crypto.randomUUID(),
  ) {
    super(message);
    this.name = 'PortalSecurityError';
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const encodeBase64Url = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(
    /=+$/,
    '',
  );
};

const decodeBase64Url = (value: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Value is not base64url encoded.');
  }
  const binary = atob(
    value.replaceAll('-', '+').replaceAll('_', '/').padEnd(
      Math.ceil(value.length / 4) * 4,
      '=',
    ),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const randomSecret = (length = 32) => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
};

const plainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join('\n') === [...keys].sort().join('\n');

const importPairingTokenKey = async (bytes: Uint8Array) => {
  if (bytes.length !== 32) {
    throw new Error('Portal Pairing Token signing key is invalid.');
  }
  return await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(bytes).buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
};

const loadPairingTokenKey = async (stateDirectory: string) => {
  const keyPath = join(stateDirectory, 'pairing-token.key');
  try {
    const bytes = decodeBase64Url((await Deno.readTextFile(keyPath)).trim());
    await Deno.chmod(keyPath, 0o600).catch(() => undefined);
    return await importPairingTokenKey(bytes);
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) throw cause;
  }

  await Deno.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  try {
    await Deno.writeTextFile(keyPath, `${encodeBase64Url(bytes)}\n`, {
      createNew: true,
      mode: 0o600,
    });
    await Deno.chmod(keyPath, 0o600);
    return await importPairingTokenKey(bytes);
  } catch (cause) {
    if (!(cause instanceof Deno.errors.AlreadyExists)) throw cause;
    const persisted = decodeBase64Url(
      (await Deno.readTextFile(keyPath)).trim(),
    );
    await Deno.chmod(keyPath, 0o600).catch(() => undefined);
    return await importPairingTokenKey(persisted);
  }
};

const unique = <Value>(values: Value[]) => [...new Set(values)];

const normalizeGrants = (grants: PortalGrants): PortalGrants => ({
  actions: unique(grants.actions).filter((action) => PORTAL_ACTIONS.includes(action)),
  workspaceIds: unique(grants.workspaceIds.filter(Boolean)),
  agentIds: unique(grants.agentIds.filter(Boolean)),
});

const credentialSummary = (
  credential: StoredCredential,
): SafeCredentialSummary => ({
  credentialId: credential.credentialId,
  principalId: credential.principalId,
  label: credential.label,
  status: credential.status,
  createdAt: credential.createdAt,
  ...(credential.lastUsedAt ? { lastUsedAt: credential.lastUsedAt } : {}),
  ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
  ...(credential.revokedAt ? { revokedAt: credential.revokedAt } : {}),
});

const principalSummary = (
  credential: StoredCredential,
): PortalPrincipalSummary => ({
  principalId: credential.principalId,
  credentialId: credential.credentialId,
  label: credential.label,
});

const parseState = (value: unknown): SecurityState => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Security state must be an object.');
  }
  const state = value as SecurityState;
  if (
    state.version !== 1 || typeof state.hostId !== 'string' || !state.hostId
  ) {
    throw new Error('Security state version or Host identity is invalid.');
  }
  if (
    !Array.isArray(state.credentials) || !Array.isArray(state.pairingOffers)
  ) {
    throw new Error('Security state collections are invalid.');
  }
  return state;
};

const assertPublicKey = async (publicKey: string) => {
  const bytes = decodeBase64Url(publicKey);
  if (bytes.length !== 65 || bytes[0] !== 4) {
    throw new Error('P-256 public key is invalid.');
  }
  await crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
};

export class PortalSecurity {
  readonly #statePath: string;
  readonly #auditPath: string;
  readonly #pairingTokenKey: CryptoKey;
  readonly #workspaceIds: Set<string>;
  #state: SecurityState;
  #mutationQueue = Promise.resolve();

  private constructor(
    readonly config: PortalConfig,
    state: SecurityState,
    pairingTokenKey: CryptoKey,
    workspaceIds: string[],
  ) {
    this.#statePath = join(config.stateDirectory, 'security.json');
    this.#auditPath = join(config.stateDirectory, 'security-audit.jsonl');
    this.#pairingTokenKey = pairingTokenKey;
    this.#workspaceIds = new Set(workspaceIds);
    this.#state = state;
  }

  static async open(
    config: PortalConfig,
    workspaceIds = config.workspaces.map(({ workspaceId }) => workspaceId),
  ) {
    const pairingTokenKey = await loadPairingTokenKey(config.stateDirectory);
    const statePath = join(config.stateDirectory, 'security.json');
    try {
      const state = parseState(JSON.parse(await Deno.readTextFile(statePath)));
      await Deno.chmod(statePath, 0o600).catch(() => undefined);
      const security = new PortalSecurity(
        config,
        state,
        pairingTokenKey,
        workspaceIds,
      );
      await security.#upgradeAdministrativeGrants();
      return security;
    } catch (cause) {
      if (!(cause instanceof Deno.errors.NotFound)) {
        throw new Error('Portal security state is invalid.', { cause });
      }
      const security = new PortalSecurity(
        config,
        {
          version: 1,
          hostId: crypto.randomUUID(),
          credentials: [],
          pairingOffers: [],
        },
        pairingTokenKey,
        workspaceIds,
      );
      await security.#persist();
      return security;
    }
  }

  get hostId() {
    return this.#state.hostId;
  }

  defaultGrants(): PortalGrants {
    return {
      actions: [...PORTAL_ACTIONS],
      workspaceIds: [...this.#workspaceIds],
      agentIds: this.config.agents.map((agent) => agent.agentId),
    };
  }

  async createPairingToken(
    ttlMs = 5 * 60_000,
    grants = this.defaultGrants(),
  ): Promise<string> {
    if (!Number.isFinite(ttlMs) || ttlMs < 10_000 || ttlMs > 60 * 60_000) {
      throw new Error(
        'Pairing lifetime must be between 10 seconds and 1 hour.',
      );
    }
    const now = new Date();
    const offer: StoredPairingOffer = {
      offerId: crypto.randomUUID(),
      grants: normalizeGrants(grants),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    await this.#mutate(async (state) => {
      state.pairingOffers = state.pairingOffers
        .filter((candidate) => !candidate.usedAt && Date.parse(candidate.expiresAt) > now.getTime())
        .concat(offer);
      await this.#audit('pairing.created', {
        auditId: crypto.randomUUID(),
        offerId: offer.offerId,
      });
    });
    const claims: PairingTokenClaims = {
      iss: this.#state.hostId,
      aud: PORTAL_PAIRING_TOKEN_AUDIENCE,
      jti: offer.offerId,
      iat: Math.floor(now.getTime() / 1_000),
      exp: Math.floor(Date.parse(offer.expiresAt) / 1_000),
    };
    const header = encodeBase64Url(
      encoder.encode(JSON.stringify({
        alg: PORTAL_PAIRING_TOKEN_ALGORITHM,
        typ: PORTAL_PAIRING_TOKEN_TYPE,
      })),
    );
    const payload = encodeBase64Url(encoder.encode(JSON.stringify(claims)));
    const signingInput = `${header}.${payload}`;
    const signature = encodeBase64Url(
      new Uint8Array(
        await crypto.subtle.sign(
          'HMAC',
          this.#pairingTokenKey,
          encoder.encode(signingInput),
        ),
      ),
    );
    return `${signingInput}.${signature}`;
  }

  async redeemPairing(request: PortalPairRequest): Promise<PortalPairResult> {
    const auditId = crypto.randomUUID();
    let claims: PairingTokenClaims;
    try {
      claims = await this.#verifyPairingToken(request.token);
    } catch {
      await this.#audit('pairing.denied', { auditId, reason: 'invalid-token' });
      throw new PortalSecurityError(
        'PAIRING_DENIED',
        'Pairing Token is invalid or expired.',
        auditId,
      );
    }
    const label = request.label.trim();
    if (!label || label.length > 100) {
      await this.#audit('pairing.denied', { auditId, reason: 'invalid-label' });
      throw new PortalSecurityError(
        'PAIRING_DENIED',
        'Pairing Token is invalid or expired.',
        auditId,
      );
    }
    try {
      await assertPublicKey(request.publicKey);
    } catch {
      await this.#audit('pairing.denied', {
        auditId,
        reason: 'invalid-public-key',
      });
      throw new PortalSecurityError(
        'PAIRING_DENIED',
        'Pairing Token is invalid or expired.',
        auditId,
      );
    }

    let paired: StoredCredential | undefined;
    await this.#mutate(async (state) => {
      const now = new Date();
      const offer = state.pairingOffers.find((candidate) =>
        candidate.offerId === claims.jti && !candidate.usedAt &&
        Date.parse(candidate.expiresAt) > now.getTime()
      );
      if (!offer) {
        await this.#audit('pairing.denied', {
          auditId,
          reason: 'invalid-or-expired',
        });
        return;
      }
      offer.usedAt = now.toISOString();
      paired = {
        credentialId: crypto.randomUUID(),
        principalId: crypto.randomUUID(),
        label,
        publicKey: request.publicKey,
        status: 'active',
        grants: offer.grants,
        createdAt: now.toISOString(),
      };
      state.credentials.push(paired);
      await this.#audit('pairing.redeemed', {
        auditId,
        credentialId: paired.credentialId,
        principalId: paired.principalId,
      });
    });
    if (!paired) {
      throw new PortalSecurityError(
        'PAIRING_DENIED',
        'Pairing Token is invalid or expired.',
        auditId,
      );
    }
    return {
      type: PORTAL_PAIR_RESULT_TYPE,
      hostId: this.hostId,
      displayName: this.config.displayName,
      principal: principalSummary(paired),
    };
  }

  async #verifyPairingToken(token: string): Promise<PairingTokenClaims> {
    if (token.length > 2_048) throw new Error('Pairing Token is too long.');
    const segments = token.split('.');
    if (segments.length !== 3 || segments.some((segment) => !segment)) {
      throw new Error('Pairing Token compact serialization is invalid.');
    }
    const [encodedHeader, encodedPayload, encodedSignature] = segments;
    const header = JSON.parse(decoder.decode(decodeBase64Url(encodedHeader)));
    if (
      !plainRecord(header) || !exactKeys(header, ['alg', 'typ']) ||
      header.alg !== PORTAL_PAIRING_TOKEN_ALGORITHM ||
      header.typ !== PORTAL_PAIRING_TOKEN_TYPE
    ) {
      throw new Error('Pairing Token protected header is invalid.');
    }
    const verified = await crypto.subtle.verify(
      'HMAC',
      this.#pairingTokenKey,
      decodeBase64Url(encodedSignature),
      encoder.encode(`${encodedHeader}.${encodedPayload}`),
    );
    if (!verified) throw new Error('Pairing Token signature is invalid.');

    const value = JSON.parse(decoder.decode(decodeBase64Url(encodedPayload)));
    if (
      !plainRecord(value) ||
      !exactKeys(value, ['iss', 'aud', 'jti', 'iat', 'exp']) ||
      value.iss !== this.hostId ||
      value.aud !== PORTAL_PAIRING_TOKEN_AUDIENCE ||
      typeof value.jti !== 'string' || !value.jti || value.jti.length > 200 ||
      typeof value.iat !== 'number' || !Number.isSafeInteger(value.iat) ||
      typeof value.exp !== 'number' || !Number.isSafeInteger(value.exp)
    ) {
      throw new Error('Pairing Token claims are invalid.');
    }
    const now = Math.floor(Date.now() / 1_000);
    const iat = value.iat;
    const exp = value.exp;
    if (
      iat > now || exp <= now || exp <= iat ||
      exp - iat > 60 * 60
    ) {
      throw new Error('Pairing Token timestamps are invalid.');
    }
    return value as PairingTokenClaims;
  }

  challenge(
    audience: PortalAuthChallenge['audience'],
    origin?: string,
  ): PortalAuthChallenge {
    const now = Date.now();
    return {
      type: PORTAL_AUTH_CHALLENGE_TYPE,
      challengeId: crypto.randomUUID(),
      hostId: this.hostId,
      nonce: randomSecret(),
      audience,
      origin: origin || '-',
      expiresAt: new Date(now + 15_000).toISOString(),
    };
  }

  async authenticate(
    challenge: PortalAuthChallenge,
    response: PortalAuthResponse,
  ): Promise<PortalPrincipal> {
    const auditId = crypto.randomUUID();
    await this.#reload();
    const credential = this.#state.credentials.find((candidate) => candidate.credentialId === response.credentialId);
    if (
      !credential || credential.status === 'revoked' ||
      Date.parse(challenge.expiresAt) <= Date.now()
    ) {
      await this.#audit('authentication.denied', {
        auditId,
        credentialId: response.credentialId,
      });
      throw new PortalSecurityError(
        'AUTHENTICATION_DENIED',
        'Portal authentication failed.',
        auditId,
      );
    }
    if (
      credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()
    ) {
      await this.#audit('authentication.denied', {
        auditId,
        credentialId: response.credentialId,
        reason: 'expired',
      });
      throw new PortalSecurityError(
        'CREDENTIAL_EXPIRED',
        'Portal credential has expired.',
        auditId,
      );
    }

    let verified = false;
    try {
      const key = await crypto.subtle.importKey(
        'raw',
        decodeBase64Url(credential.publicKey),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
      verified = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        decodeBase64Url(response.signature),
        encoder.encode(portalAuthChallengePayload(challenge)),
      );
    } catch {
      verified = false;
    }
    if (!verified) {
      await this.#audit('authentication.denied', {
        auditId,
        credentialId: response.credentialId,
      });
      throw new PortalSecurityError(
        'AUTHENTICATION_DENIED',
        'Portal authentication failed.',
        auditId,
      );
    }

    let authenticated: StoredCredential | undefined;
    await this.#mutate(async (state) => {
      const current = state.credentials.find((candidate) => candidate.credentialId === credential.credentialId);
      if (
        !current || current.status === 'revoked' ||
        (current.expiresAt && Date.parse(current.expiresAt) <= Date.now())
      ) return;
      const now = new Date().toISOString();
      current.lastUsedAt = now;
      if (current.status === 'pending' && current.replacesCredentialId) {
        current.status = 'active';
        const replaced = state.credentials.find((candidate) => candidate.credentialId === current.replacesCredentialId);
        if (replaced && replaced.status !== 'revoked') {
          replaced.status = 'revoked';
          replaced.revokedAt = now;
        }
      }
      authenticated = current;
      await this.#audit('authentication.accepted', {
        auditId,
        credentialId: current.credentialId,
        principalId: current.principalId,
      });
    });
    if (!authenticated) {
      await this.#audit('authentication.denied', {
        auditId,
        credentialId: response.credentialId,
        reason: 'credential-changed',
      });
      throw new PortalSecurityError(
        'AUTHENTICATION_DENIED',
        'Portal authentication failed.',
        auditId,
      );
    }
    return { ...principalSummary(authenticated), grants: authenticated.grants };
  }

  async assertActive(principal: PortalPrincipal) {
    await this.#reload();
    const credential = this.#state.credentials.find((candidate) => candidate.credentialId === principal.credentialId);
    if (
      !credential || credential.status !== 'active' ||
      (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now())
    ) {
      throw new PortalSecurityError(
        'CREDENTIAL_REVOKED',
        'Portal credential is no longer active.',
      );
    }
    principal.grants = credential.grants;
  }

  async registerWorkspace(principal: PortalPrincipal, workspaceId: string) {
    this.#workspaceIds.add(workspaceId);
    await this.#mutate(async (state) => {
      for (const credential of state.credentials) {
        if (!credential.grants.actions.includes('workspace.manage')) continue;
        credential.grants.workspaceIds = unique([
          ...credential.grants.workspaceIds,
          workspaceId,
        ]);
      }
      for (const offer of state.pairingOffers) {
        if (!offer.grants.actions.includes('workspace.manage')) continue;
        offer.grants.workspaceIds = unique([
          ...offer.grants.workspaceIds,
          workspaceId,
        ]);
      }
      await this.#audit('workspace.registered', {
        auditId: crypto.randomUUID(),
        principalId: principal.principalId,
        credentialId: principal.credentialId,
        workspaceId,
      });
    });
    await this.assertActive(principal);
  }

  async unregisterWorkspace(principal: PortalPrincipal, workspaceId: string) {
    this.#workspaceIds.delete(workspaceId);
    await this.#mutate(async (state) => {
      for (const credential of state.credentials) {
        credential.grants.workspaceIds = credential.grants.workspaceIds.filter(
          (candidate) => candidate !== workspaceId,
        );
      }
      for (const offer of state.pairingOffers) {
        offer.grants.workspaceIds = offer.grants.workspaceIds.filter(
          (candidate) => candidate !== workspaceId,
        );
      }
      await this.#audit('workspace.unregistered', {
        auditId: crypto.randomUUID(),
        principalId: principal.principalId,
        credentialId: principal.credentialId,
        workspaceId,
      });
    });
    await this.assertActive(principal);
  }

  allows(
    principal: PortalPrincipal,
    action: PortalAction,
    resource: PortalResource = {},
  ) {
    if (!principal.grants.actions.includes(action)) return false;
    if (
      resource.workspaceId &&
      !principal.grants.workspaceIds.includes(resource.workspaceId)
    ) return false;
    if (
      resource.agentId && !principal.grants.agentIds.includes(resource.agentId)
    ) return false;
    return true;
  }

  async authorize(
    principal: PortalPrincipal,
    action: PortalAction,
    resource: PortalResource = {},
  ) {
    await this.assertActive(principal);
    if (this.allows(principal, action, resource)) return;
    const auditId = crypto.randomUUID();
    await this.#audit('authorization.denied', {
      auditId,
      principalId: principal.principalId,
      credentialId: principal.credentialId,
      action,
      ...(resource.workspaceId ? { workspaceId: resource.workspaceId } : {}),
      ...(resource.agentId ? { agentId: resource.agentId } : {}),
      ...(resource.threadId ? { threadId: resource.threadId } : {}),
      ...(resource.terminalId ? { terminalId: resource.terminalId } : {}),
    });
    throw new PortalSecurityError(
      'RESOURCE_UNAVAILABLE',
      'Resource is unavailable.',
      auditId,
    );
  }

  async auditThreadLifecycle(
    principal: PortalPrincipal,
    event: 'thread.archived' | 'thread.restored',
    resource: Required<
      Pick<PortalResource, 'threadId' | 'workspaceId' | 'agentId'>
    >,
    changed: boolean,
  ) {
    await this.#audit(event, {
      auditId: crypto.randomUUID(),
      principalId: principal.principalId,
      credentialId: principal.credentialId,
      threadId: resource.threadId,
      workspaceId: resource.workspaceId,
      agentId: resource.agentId,
      changed,
    });
  }

  async rotate(principal: PortalPrincipal, publicKey: string, label?: string) {
    const replacementLabel = label?.trim() || principal.label;
    if (replacementLabel.length > 100) {
      throw new Error('Credential label must be at most 100 characters.');
    }
    await assertPublicKey(publicKey);
    await this.authorize(principal, 'credential.rotate');
    let replacement: StoredCredential | undefined;
    await this.#mutate(async (state) => {
      const current = state.credentials.find((candidate) => candidate.credentialId === principal.credentialId);
      if (!current || current.status !== 'active') return;
      replacement = {
        credentialId: crypto.randomUUID(),
        principalId: current.principalId,
        label: replacementLabel,
        publicKey,
        status: 'pending',
        grants: current.grants,
        createdAt: new Date().toISOString(),
        replacesCredentialId: current.credentialId,
      };
      state.credentials.push(replacement);
      await this.#audit('credential.rotation-staged', {
        auditId: crypto.randomUUID(),
        principalId: current.principalId,
        credentialId: current.credentialId,
        replacementCredentialId: replacement.credentialId,
      });
    });
    if (!replacement) {
      throw new PortalSecurityError(
        'CREDENTIAL_REVOKED',
        'Portal credential is no longer active.',
      );
    }
    return replacement.credentialId;
  }

  async revoke(principal: PortalPrincipal) {
    await this.authorize(principal, 'credential.revoke');
    await this.revokeCredential(principal.credentialId);
  }

  async revokeCredential(credentialId: string) {
    let changed = false;
    await this.#mutate(async (state) => {
      const credential = state.credentials.find((candidate) => candidate.credentialId === credentialId);
      if (!credential || credential.status === 'revoked') return;
      credential.status = 'revoked';
      credential.revokedAt = new Date().toISOString();
      changed = true;
      await this.#audit('credential.revoked', {
        auditId: crypto.randomUUID(),
        principalId: credential.principalId,
        credentialId,
      });
    });
    return changed;
  }

  async listCredentials() {
    await this.#reload();
    return this.#state.credentials.map(credentialSummary);
  }

  async #reload() {
    this.#state = parseState(
      JSON.parse(await Deno.readTextFile(this.#statePath)),
    );
  }

  async #upgradeAdministrativeGrants() {
    const newlyAddedActions: PortalAction[] = ['workspace.manage', 'browser.observe', 'browser.control'];
    const legacyActions = PORTAL_ACTIONS.filter((action) => !newlyAddedActions.includes(action));
    const configuredAgentIds = this.config.agents.map(({ agentId }) => agentId);
    const upgrade = (grants: PortalGrants) => {
      const wasAdministrative = legacyActions.every((action) => grants.actions.includes(action)) &&
        configuredAgentIds.every((agentId) => grants.agentIds.includes(agentId));
      if (!wasAdministrative) return false;
      const actions = unique([...grants.actions, ...newlyAddedActions]);
      const workspaceIds = unique([
        ...grants.workspaceIds,
        ...this.#workspaceIds,
      ]);
      const changed = actions.length !== grants.actions.length ||
        workspaceIds.length !== grants.workspaceIds.length;
      grants.actions = actions;
      grants.workspaceIds = workspaceIds;
      return changed;
    };
    let changed = false;
    for (const { grants } of this.#state.credentials) {
      changed = upgrade(grants) || changed;
    }
    for (const { grants } of this.#state.pairingOffers) {
      changed = upgrade(grants) || changed;
    }
    if (changed) await this.#persist();
  }

  async #mutate(operation: (state: SecurityState) => Promise<void>) {
    const result = this.#mutationQueue.then(async () => {
      await this.#reload();
      await operation(this.#state);
      await this.#persist();
    });
    this.#mutationQueue = result.then(() => undefined, () => undefined);
    return await result;
  }

  async #persist() {
    await Deno.mkdir(dirname(this.#statePath), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${this.#statePath}.${crypto.randomUUID()}.tmp`;
    try {
      await Deno.writeTextFile(
        temporary,
        `${JSON.stringify(this.#state, null, 2)}\n`,
        { mode: 0o600 },
      );
      await Deno.rename(temporary, this.#statePath);
      await Deno.chmod(this.#statePath, 0o600);
    } finally {
      await Deno.remove(temporary).catch((cause) => {
        if (!(cause instanceof Deno.errors.NotFound)) throw cause;
      });
    }
  }

  async #audit(event: string, fields: Record<string, unknown>) {
    await Deno.mkdir(dirname(this.#auditPath), {
      recursive: true,
      mode: 0o700,
    });
    await Deno.writeTextFile(
      this.#auditPath,
      `${
        JSON.stringify({
          version: 1,
          event,
          createdAt: new Date().toISOString(),
          ...fields,
        })
      }\n`,
      { append: true, create: true, mode: 0o600 },
    );
    await Deno.chmod(this.#auditPath, 0o600);
  }
}
