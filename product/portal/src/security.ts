import {
  PORTAL_AUTH_CHALLENGE_TYPE,
  PORTAL_PAIR_RESULT_TYPE,
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
  'thread.inspect',
  'thread.create',
  'thread.attach',
  'workspace.file.read',
  'workspace.file.write',
  'agent.use',
  'terminal.observe',
  'terminal.control',
  'credential.rotate',
  'credential.revoke',
] as const;

export type PortalAction = typeof PORTAL_ACTIONS[number];
export type PortalResource = {
  workspaceId?: string;
  agentId?: string;
  threadId?: string;
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
  label: string;
  secretHash: string;
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

export type PairingOffer = {
  hostId: string;
  displayName: string;
  publicUrl?: string;
  offerId: string;
  secret: string;
  label: string;
  expiresAt: string;
  grants: PortalGrants;
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

const hashSecret = async (secret: string) =>
  encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(secret)),
    ),
  );

const equal = (left: string, right: string) => {
  const size = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < size; index++) {
    difference |= (left.charCodeAt(index) || 0) ^
      (right.charCodeAt(index) || 0);
  }
  return difference === 0;
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
  #state: SecurityState;
  #mutationQueue = Promise.resolve();

  private constructor(readonly config: PortalConfig, state: SecurityState) {
    this.#statePath = join(config.stateDirectory, 'security.json');
    this.#auditPath = join(config.stateDirectory, 'security-audit.jsonl');
    this.#state = state;
  }

  static async open(config: PortalConfig) {
    const statePath = join(config.stateDirectory, 'security.json');
    try {
      const state = parseState(JSON.parse(await Deno.readTextFile(statePath)));
      await Deno.chmod(statePath, 0o600).catch(() => undefined);
      return new PortalSecurity(config, state);
    } catch (cause) {
      if (!(cause instanceof Deno.errors.NotFound)) {
        throw new Error('Portal security state is invalid.', { cause });
      }
      const security = new PortalSecurity(config, {
        version: 1,
        hostId: crypto.randomUUID(),
        credentials: [],
        pairingOffers: [],
      });
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
      workspaceIds: this.config.workspaces.map((workspace) => workspace.workspaceId),
      agentIds: this.config.agents.map((agent) => agent.agentId),
    };
  }

  async createPairingOffer(
    label: string,
    ttlMs = 5 * 60_000,
    grants = this.defaultGrants(),
  ): Promise<PairingOffer> {
    const normalizedLabel = label.trim();
    if (!normalizedLabel || normalizedLabel.length > 100) {
      throw new Error('Pairing label must be 1 to 100 characters.');
    }
    if (!Number.isFinite(ttlMs) || ttlMs < 10_000 || ttlMs > 60 * 60_000) {
      throw new Error(
        'Pairing lifetime must be between 10 seconds and 1 hour.',
      );
    }
    const secret = randomSecret();
    const now = new Date();
    const offer: StoredPairingOffer = {
      offerId: crypto.randomUUID(),
      label: normalizedLabel,
      secretHash: await hashSecret(secret),
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
    return {
      hostId: this.#state.hostId,
      displayName: this.config.displayName,
      ...(this.config.publicUrl ? { publicUrl: this.config.publicUrl } : {}),
      offerId: offer.offerId,
      secret,
      label: offer.label,
      expiresAt: offer.expiresAt,
      grants: offer.grants,
    };
  }

  async redeemPairing(request: PortalPairRequest): Promise<PortalPairResult> {
    const auditId = crypto.randomUUID();
    if (request.hostId !== this.hostId) {
      await this.#audit('pairing.denied', { auditId, reason: 'host-mismatch' });
      throw new PortalSecurityError(
        'PAIRING_DENIED',
        'Pairing offer is invalid or expired.',
        auditId,
      );
    }
    const label = request.label.trim();
    if (!label || label.length > 100) {
      await this.#audit('pairing.denied', { auditId, reason: 'invalid-label' });
      throw new PortalSecurityError(
        'PAIRING_DENIED',
        'Pairing offer is invalid or expired.',
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
        'Pairing offer is invalid or expired.',
        auditId,
      );
    }

    let paired: StoredCredential | undefined;
    await this.#mutate(async (state) => {
      const hash = await hashSecret(request.secret);
      const now = new Date();
      const offer = state.pairingOffers.find((candidate) =>
        candidate.offerId === request.offerId && !candidate.usedAt &&
        Date.parse(candidate.expiresAt) > now.getTime() &&
        equal(candidate.secretHash, hash)
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
        'Pairing offer is invalid or expired.',
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
    });
    throw new PortalSecurityError(
      'RESOURCE_UNAVAILABLE',
      'Resource is unavailable.',
      auditId,
    );
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
