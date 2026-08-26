import {
  parsePortalPairResult,
  PORTAL_PAIR_PATH,
  PORTAL_PAIR_REQUEST_TYPE,
  PORTAL_WEBSOCKET_PROTOCOL,
  type PortalPairResult,
} from '@weave/product-protocol';
import { portalWebSocketUrl } from '@/portal-address';
import { createPortalCredentialKey, deletePortalCredentialKey } from '@/portal-credential';

export type PortalPairingCode = {
  hostId: string;
  displayName: string;
  publicUrl?: string;
  offerId: string;
  secret: string;
  expiresAt: string;
};

export type PairedPortalConnection = {
  hostId: string;
  displayName: string;
  hostUrl: string;
  credentialId: string;
  keyId: string;
};

export const parsePortalPairingCode = (value: string): PortalPairingCode => {
  let input: unknown;
  try {
    input = JSON.parse(value.trim());
  } catch {
    throw new Error(
      'Pairing code is not valid JSON. Paste the complete output from Portal.',
    );
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Pairing code is invalid.');
  }
  const code = input as Record<string, unknown>;
  for (
    const field of [
      'hostId',
      'displayName',
      'offerId',
      'secret',
      'expiresAt',
    ] as const
  ) {
    if (typeof code[field] !== 'string' || !code[field]) {
      throw new Error('Pairing code is incomplete.');
    }
  }
  if (
    code.publicUrl !== undefined &&
    (typeof code.publicUrl !== 'string' || !code.publicUrl)
  ) {
    throw new Error('Pairing code Host URL is invalid.');
  }
  if (Date.parse(code.expiresAt as string) <= Date.now()) {
    throw new Error('Pairing code has expired. Create a new one on Portal.');
  }
  return code as PortalPairingCode;
};

const pairSocket = async (
  hostUrl: string,
  request: {
    hostId: string;
    offerId: string;
    secret: string;
    label: string;
    publicKey: string;
  },
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
    socket.onerror = () => settle(reject, new Error('Could not reach Portal for pairing.'));
    socket.onclose = (event) => {
      if (event.code !== 1000) {
        settle(reject, new Error(event.reason || 'Portal pairing failed.'));
      }
    };
    socket.onmessage = (event) => {
      try {
        const result = parsePortalPairResult(JSON.parse(String(event.data)));
        if (result.hostId !== request.hostId) {
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
  pairingCode: string;
  hostUrl?: string;
  deviceLabel: string;
}): Promise<PairedPortalConnection> {
  const code = parsePortalPairingCode(input.pairingCode);
  const hostUrl = input.hostUrl?.trim() || code.publicUrl;
  if (!hostUrl) {
    throw new Error(
      'Host URL is required because Portal did not include a public URL.',
    );
  }
  const keyId = `weave.portal.${crypto.randomUUID()}`;
  const key = await createPortalCredentialKey(keyId);
  try {
    const paired = await pairSocket(hostUrl, {
      hostId: code.hostId,
      offerId: code.offerId,
      secret: code.secret,
      label: input.deviceLabel.trim() || 'Weave device',
      publicKey: key.publicKey,
    });
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
