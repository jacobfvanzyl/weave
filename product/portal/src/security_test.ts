import { test } from './test-support.ts';
import { readText, removePath, stat, temporaryDirectory } from './host-files.ts';
import {
  PORTAL_PAIR_REQUEST_TYPE,
  PORTAL_PAIRING_TOKEN_ALGORITHM,
  PORTAL_PAIRING_TOKEN_AUDIENCE,
  PORTAL_PAIRING_TOKEN_TYPE,
  PORTAL_RPC_PATH,
  portalAuthChallengePayload,
} from '@weave/product-protocol';
import { assertEquals, assertRejects } from './test-support.ts';
import { join } from 'node:path';
import { generatePortalKey, type PortalCredentialSigner } from '../scripts/rpc-client.ts';
import type { PortalConfig } from './config.ts';
import { PORTAL_ACTIONS, type PortalGrants, PortalSecurity, PortalSecurityError } from './security.ts';

const encodeBase64Url = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

const decodeBase64Url = (value: string) => {
  const binary = atob(
    value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '='),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const decodeJwtPart = (value: string) =>
  JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as Record<string, unknown>;

const signJwt = async (
  keyBytes: Uint8Array,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
) => {
  const encodedHeader = encodeBase64Url(new TextEncoder().encode(JSON.stringify(header)));
  const encodedClaims = encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(keyBytes).buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
};

const config = (root: string): PortalConfig => ({
  listen: { hostname: '127.0.0.1', port: 0 },
  displayName: 'Security Test Portal',
  allowedOrigins: [],
  stateDirectory: join(root, 'state'),
  workspaces: [
    { workspaceId: 'allowed', name: 'Allowed', path: root },
    { workspaceId: 'denied', name: 'Denied', path: root },
  ],
  agents: [{
    agentId: 'agent',
    name: 'Agent',
    command: 'false',
    args: [],
    env: {},
  }],
});

const pair = async (
  security: PortalSecurity,
  grants?: PortalGrants,
): Promise<PortalCredentialSigner> => {
  const key = await generatePortalKey();
  const token = await security.createPairingToken(60_000, grants);
  const paired = await security.redeemPairing({
    type: PORTAL_PAIR_REQUEST_TYPE,
    token,
    label: 'Ignored client label',
    publicKey: key.publicKey,
  });
  return { ...key, credentialId: paired.principal.credentialId };
};

const authenticate = async (
  security: PortalSecurity,
  credential: PortalCredentialSigner,
) => {
  const challenge = security.challenge(PORTAL_RPC_PATH);
  return await security.authenticate(challenge, {
    type: 'weave.portal.auth.response',
    credentialId: credential.credentialId,
    signature: await credential.sign(portalAuthChallengePayload(challenge)),
  });
};

test('Portal Pairing Tokens are one-time and Host identity survives restart', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-portal-security-' });
  try {
    const security = await PortalSecurity.open(config(root));
    const hostId = security.hostId;
    const credential = await pair(security);
    assertEquals(
      (await authenticate(security, credential)).credentialId,
      credential.credentialId,
    );
    assertEquals((await PortalSecurity.open(config(root))).hostId, hostId);

    const key = await generatePortalKey();
    const token = await security.createPairingToken(60_000);
    const request = {
      type: PORTAL_PAIR_REQUEST_TYPE,
      token,
      label: 'One use',
      publicKey: key.publicKey,
    } as const;
    // Change significant signature bits; the final base64url character can
    // differ only in padding bits and still decode to the same signature.
    const signatureStart = token.lastIndexOf('.') + 1;
    const altered = `${token.slice(0, signatureStart)}${token[signatureStart] === 'A' ? 'B' : 'A'}${token.slice(signatureStart + 1)}`;
    await assertRejects(
      () => security.redeemPairing({ ...request, token: altered }),
      PortalSecurityError,
      'invalid or expired',
    );
    await security.redeemPairing(request);
    await assertRejects(
      () => security.redeemPairing(request),
      PortalSecurityError,
      'invalid or expired',
    );
  } finally {
    await removePath(root, { recursive: true });
  }
});

test('Portal Pairing Tokens use a strict minimal signed JWT profile', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-portal-pairing-token-' });
  const otherRoot = await temporaryDirectory({ prefix: 'weave-portal-pairing-token-other-' });
  try {
    const security = await PortalSecurity.open(config(root));
    const token = await security.createPairingToken(60_000, {
      actions: ['portal.inspect'],
      workspaceIds: ['allowed'],
      agentIds: ['agent'],
    });
    const [encodedHeader, encodedClaims] = token.split('.');
    const header = decodeJwtPart(encodedHeader);
    const claims = decodeJwtPart(encodedClaims);
    assertEquals(header, {
      alg: PORTAL_PAIRING_TOKEN_ALGORITHM,
      typ: PORTAL_PAIRING_TOKEN_TYPE,
    });
    assertEquals(Object.keys(claims).sort(), ['aud', 'exp', 'iat', 'iss', 'jti']);
    assertEquals(claims.iss, security.hostId);
    assertEquals(claims.aud, PORTAL_PAIRING_TOKEN_AUDIENCE);

    const keyPath = join(root, 'state', 'pairing-token.key');
    assertEquals((await stat(keyPath)).mode! & 0o777, 0o600);
    const keyBytes = decodeBase64Url((await readText(keyPath)).trim());
    const validHeader = {
      alg: PORTAL_PAIRING_TOKEN_ALGORITHM,
      typ: PORTAL_PAIRING_TOKEN_TYPE,
    };
    const key = await generatePortalKey();
    const request = {
      type: PORTAL_PAIR_REQUEST_TYPE,
      token,
      label: 'Test client',
      publicKey: key.publicKey,
    } as const;
    const denied = async (candidate: string) => {
      await assertRejects(
        () => security.redeemPairing({ ...request, token: candidate }),
        PortalSecurityError,
        'invalid or expired',
      );
    };
    await denied(await signJwt(keyBytes, { ...validHeader, typ: 'JWT' }, claims));
    await denied(await signJwt(keyBytes, { ...validHeader, alg: 'none' }, claims));
    await denied(await signJwt(keyBytes, validHeader, { ...claims, iss: 'another-host' }));
    await denied(await signJwt(keyBytes, validHeader, { ...claims, aud: 'another-audience' }));
    await denied(await signJwt(keyBytes, validHeader, { ...claims, iat: Math.floor(Date.now() / 1_000) + 60 }));
    await denied(await signJwt(keyBytes, validHeader, { ...claims, exp: Math.floor(Date.now() / 1_000) - 1 }));
    await denied(await signJwt(keyBytes, validHeader, { ...claims, jti: crypto.randomUUID() }));
    await denied(await signJwt(keyBytes, validHeader, { ...claims, grants: ['portal.inspect'] }));

    const otherSecurity = await PortalSecurity.open(config(otherRoot));
    const otherKeyBytes = decodeBase64Url(
      (await readText(join(otherRoot, 'state', 'pairing-token.key'))).trim(),
    );
    await denied(await signJwt(otherKeyBytes, validHeader, claims));
    assertEquals(typeof otherSecurity.hostId, 'string');

    const reopened = await PortalSecurity.open(config(root));
    assertEquals((await reopened.redeemPairing(request)).hostId, security.hostId);
    await assertRejects(
      () => reopened.redeemPairing(request),
      PortalSecurityError,
      'invalid or expired',
    );
  } finally {
    await removePath(root, { recursive: true });
    await removePath(otherRoot, { recursive: true });
  }
});

test('Portal credential rotation is explicit and interruption-safe', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-portal-rotation-' });
  try {
    const security = await PortalSecurity.open(config(root));
    const original = await pair(security);
    const principal = await authenticate(security, original);
    const replacementKey = await generatePortalKey();
    const replacementId = await security.rotate(
      principal,
      replacementKey.publicKey,
      'Replacement iPad key',
    );

    assertEquals(
      (await authenticate(security, original)).credentialId,
      original.credentialId,
    );
    const replacement = { ...replacementKey, credentialId: replacementId };
    assertEquals(
      (await authenticate(security, replacement)).credentialId,
      replacementId,
    );
    await assertRejects(
      () => authenticate(security, original),
      PortalSecurityError,
      'authentication failed',
    );
    assertEquals(
      (await security.listCredentials()).map(({ credentialId, status }) => ({
        credentialId,
        status,
      })),
      [
        { credentialId: original.credentialId, status: 'revoked' },
        { credentialId: replacementId, status: 'active' },
      ],
    );
  } finally {
    await removePath(root, { recursive: true });
  }
});

test('Portal authorization applies resource grants without revealing denied resources', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-portal-grants-' });
  try {
    const security = await PortalSecurity.open(config(root));
    const credential = await pair(security, {
      actions: ['portal.inspect', 'workspace.inspect', 'workspace.file.read'],
      workspaceIds: ['allowed'],
      agentIds: [],
    });
    const principal = await authenticate(security, credential);
    await security.authorize(principal, 'workspace.file.read', {
      workspaceId: 'allowed',
    });
    await assertRejects(
      () =>
        security.authorize(principal, 'workspace.file.read', {
          workspaceId: 'denied',
        }),
      PortalSecurityError,
      'Resource is unavailable.',
    );
    await assertRejects(
      () =>
        security.authorize(principal, 'workspace.file.write', {
          workspaceId: 'allowed',
        }),
      PortalSecurityError,
      'Resource is unavailable.',
    );
  } finally {
    await removePath(root, { recursive: true });
  }
});

test('Portal upgrades existing administrative pairings for project registration', async () => {
  const root = await temporaryDirectory({ prefix: 'weave-portal-grants-' });
  try {
    const initial = await PortalSecurity.open(config(root));
    const credential = await pair(initial, {
      actions: PORTAL_ACTIONS.filter((action) => action !== 'workspace.manage'),
      workspaceIds: ['allowed', 'denied'],
      agentIds: ['agent'],
    });
    const reopened = await PortalSecurity.open(config(root), [
      'allowed',
      'denied',
      'registered-later',
    ]);
    const principal = await authenticate(reopened, credential);
    await reopened.authorize(principal, 'workspace.manage');
    await reopened.authorize(principal, 'workspace.inspect', {
      workspaceId: 'registered-later',
    });
  } finally {
    await removePath(root, { recursive: true });
  }
});
