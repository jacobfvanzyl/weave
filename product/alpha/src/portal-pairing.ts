import {
  parsePortalPairResult,
  PORTAL_PAIR_PATH,
  PORTAL_PAIRING_TOKEN_ALGORITHM,
  PORTAL_PAIRING_TOKEN_AUDIENCE,
  PORTAL_PAIRING_TOKEN_TYPE,
  PORTAL_PAIR_REQUEST_TYPE,
  PORTAL_WEBSOCKET_PROTOCOL,
  type PortalPairResult,
} from '@weave/product-protocol';
import { portalWebSocketUrl } from '@/portal-address';
import { createPortalCredentialKey, deletePortalCredentialKey } from '@/portal-credential';

export type PortalPairingToken = {
  token: string;
  hostId: string;
  issuedAt: number;
  expiresAt: number;
};

export type PairedPortalConnection = {
  hostId: string;
  displayName: string;
  hostUrl: string;
  credentialId: string;
  keyId: string;
};

const decodeBase64UrlJson = (value: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Pairing Token is not base64url encoded.');
  }
  try {
    const binary = atob(
      value.replaceAll('-', '+').replaceAll('_', '/').padEnd(
        Math.ceil(value.length / 4) * 4,
        '=',
      ),
    );
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(binary, (character) => character.charCodeAt(0)),
      ),
    ) as unknown;
  } catch {
    throw new Error('Pairing Token is malformed. Paste the complete token from Portal.');
  }
};

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Pairing Token is malformed.');
  }
  return value as Record<string, unknown>;
};

const hasExactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join('\n') === [...keys].sort().join('\n');

export const parsePortalPairingToken = (value: string): PortalPairingToken => {
  const token = value.trim();
  if (token.length > 2_048) throw new Error('Pairing Token is too long.');
  const segments = token.split('.');
  if (segments.length !== 3 || segments.some((segment) => !segment)) {
    throw new Error('Pairing Token must be a compact JWT.');
  }
  const [encodedHeader, encodedPayload, signature] = segments;
  if (!/^[A-Za-z0-9_-]+$/.test(signature)) throw new Error('Pairing Token signature is malformed.');
  const header = record(decodeBase64UrlJson(encodedHeader));
  if (
    !hasExactKeys(header, ['alg', 'typ']) ||
    header.alg !== PORTAL_PAIRING_TOKEN_ALGORITHM ||
    header.typ !== PORTAL_PAIRING_TOKEN_TYPE
  ) {
    throw new Error('Pairing Token header is invalid.');
  }
  const claims = record(decodeBase64UrlJson(encodedPayload));
  if (
    !hasExactKeys(claims, ['iss', 'aud', 'jti', 'iat', 'exp']) ||
    typeof claims.iss !== 'string' || !claims.iss ||
    claims.aud !== PORTAL_PAIRING_TOKEN_AUDIENCE ||
    typeof claims.jti !== 'string' || !claims.jti ||
    !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)
  ) {
    throw new Error('Pairing Token claims are invalid.');
  }
  const issuedAt = claims.iat as number;
  const expiresAt = claims.exp as number;
  const now = Math.floor(Date.now() / 1_000);
  if (issuedAt > now || expiresAt <= issuedAt || expiresAt - issuedAt > 60 * 60) {
    throw new Error('Pairing Token timestamps are invalid.');
  }
  if (expiresAt <= now) {
    throw new Error('Pairing Token has expired. Create a new one on Portal.');
  }
  return { token, hostId: claims.iss, issuedAt, expiresAt };
};

const pairSocket = async (
  hostUrl: string,
  request: {
    token: string;
    label: string;
    publicKey: string;
  },
  expectedHostId: string,
) => {
  const url = portalWebSocketUrl(hostUrl);
  url.pathname = PORTAL_PAIR_PATH;
  const socket = new WebSocket(url, PORTAL_WEBSOCKET_PROTOCOL);
  return await new Promise<PortalPairResult>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error('Portal pairing timed out.'));
      socket.close();
    }, 20_000);
    const settle = <Value>(operation: (value: Value) => void, value: Value) => {
      window.clearTimeout(timer);
      operation(value);
    };
    socket.onopen = () =>
      socket.send(
        JSON.stringify({ type: PORTAL_PAIR_REQUEST_TYPE, ...request }),
      );
    socket.onerror = () =>
      settle(
        reject,
        new Error(`Could not reach Portal at ${url.origin} for pairing. Check the Host URL and TLS certificate.`),
      );
    socket.onclose = (event) => {
      if (event.code !== 1000) {
        settle(reject, new Error(event.reason || 'Portal pairing failed.'));
      }
    };
    socket.onmessage = (event) => {
      try {
        const result = parsePortalPairResult(JSON.parse(String(event.data)));
        if (result.hostId !== expectedHostId) {
          throw new Error('Portal returned a different Host identity.');
        }
        settle(resolve, result);
      } catch (cause) {
        settle(reject, cause);
      }
    };
  }).finally(() => socket.close());
};

export async function pairPortalHost(input: {
  pairingToken: string;
  hostUrl?: string;
  deviceLabel: string;
}): Promise<PairedPortalConnection> {
  const pairing = parsePortalPairingToken(input.pairingToken);
  const hostUrl = input.hostUrl?.trim();
  if (!hostUrl) {
    throw new Error('Host URL is required to redeem a Pairing Token.');
  }
  const keyId = `weave.portal.${crypto.randomUUID()}`;
  const key = await createPortalCredentialKey(keyId);
  try {
    const paired = await pairSocket(hostUrl, {
      token: pairing.token,
      label: input.deviceLabel.trim() || 'Weave device',
      publicKey: key.publicKey,
    }, pairing.hostId);
    return {
      hostId: paired.hostId,
      displayName: paired.displayName,
      hostUrl,
      credentialId: paired.principal.credentialId,
      keyId,
    };
  } catch (cause) {
    await deletePortalCredentialKey(keyId).catch(() => undefined);
    throw cause;
  }
}
