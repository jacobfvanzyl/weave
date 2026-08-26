import { PORTAL_PAIR_REQUEST_TYPE, PORTAL_RPC_PATH, portalAuthChallengePayload } from '@weave/product-protocol';
import { assertEquals, assertRejects } from 'jsr:@std/assert@1.0.14';
import { join } from 'jsr:@std/path@1.1.2';
import { generatePortalKey, type PortalCredentialSigner } from '../scripts/rpc-client.ts';
import type { PortalConfig } from './config.ts';
import { type PortalGrants, PortalSecurity, PortalSecurityError } from './security.ts';

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
  const offer = await security.createPairingOffer('Test iPad', 60_000, grants);
  const paired = await security.redeemPairing({
    type: PORTAL_PAIR_REQUEST_TYPE,
    hostId: offer.hostId,
    offerId: offer.offerId,
    secret: offer.secret,
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

Deno.test('Portal pairing offers are one-time and Host identity survives restart', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-portal-security-' });
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
    const offer = await security.createPairingOffer('One use', 60_000);
    const request = {
      type: PORTAL_PAIR_REQUEST_TYPE,
      hostId,
      offerId: offer.offerId,
      secret: offer.secret,
      label: 'One use',
      publicKey: key.publicKey,
    } as const;
    await assertRejects(
      () => security.redeemPairing({ ...request, offerId: crypto.randomUUID() }),
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
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Portal credential rotation is explicit and interruption-safe', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-portal-rotation-' });
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
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Portal authorization applies resource grants without revealing denied resources', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-portal-grants-' });
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
    await Deno.remove(root, { recursive: true });
  }
});
