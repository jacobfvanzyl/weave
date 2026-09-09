import {
  PORTAL_AUTH_CHALLENGE_TYPE,
  PORTAL_AUTH_RESPONSE_TYPE,
  PORTAL_AUTHENTICATED_TYPE,
  PORTAL_PAIR_PATH,
  PORTAL_PAIR_REQUEST_TYPE,
  PORTAL_PAIR_RESULT_TYPE,
  PORTAL_WEBSOCKET_PROTOCOL,
  type PortalAuthChallenge,
  portalAuthChallengePayload,
} from '@weave/product-protocol';
import { idKey, type JsonRpcMessage, parseJsonRpcMessage } from '../src/json-rpc.ts';

export const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const encodeBase64Url = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(
    /=+$/,
    '',
  );
};

export type PortalCredentialSigner = {
  credentialId: string;
  publicKey: string;
  sign(payload: string): Promise<string>;
};

export type UnpairedPortalKey = Omit<PortalCredentialSigner, 'credentialId'>;

export const generatePortalKey = async (): Promise<UnpairedPortalKey> => {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const publicKey = encodeBase64Url(
    new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
  );
  return {
    publicKey,
    sign: async (payload) =>
      encodeBase64Url(
        new Uint8Array(
          await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            pair.privateKey,
            new TextEncoder().encode(payload),
          ),
        ),
      ),
  };
};

export const pairPortalCredential = async (
  baseUrl: string,
  pairingToken: string,
  label: string,
) => {
  const token = pairingToken.trim();
  if (token.split('.').length !== 3) throw new Error('Pairing Token is invalid.');
  const key = await generatePortalKey();
  const socket = new WebSocket(
    `${baseUrl.replace(/\/$/, '')}${PORTAL_PAIR_PATH}`,
    PORTAL_WEBSOCKET_PROTOCOL,
  );
  const paired = await new Promise<{ principal: { credentialId: string } }>(
    (resolve, reject) => {
      socket.onopen = () =>
        socket.send(JSON.stringify({
          type: PORTAL_PAIR_REQUEST_TYPE,
          token,
          label,
          publicKey: key.publicKey,
        }));
      socket.onerror = () => reject(new Error('Could not open the Portal pairing connection.'));
      socket.onclose = (event) => {
        if (event.code !== 1000) {
          reject(new Error(event.reason || 'Portal pairing failed.'));
        }
      };
      socket.onmessage = (event) => {
        const result = JSON.parse(String(event.data)) as {
          type?: unknown;
          principal?: { credentialId?: unknown };
        };
        if (
          result.type !== PORTAL_PAIR_RESULT_TYPE ||
          typeof result.principal?.credentialId !== 'string'
        ) {
          reject(new Error('Portal pairing result is invalid.'));
          return;
        }
        resolve(result as { principal: { credentialId: string } });
      };
    },
  ).finally(() => socket.close());
  return { ...key, credentialId: paired.principal.credentialId };
};

const authentication = async (
  socket: WebSocket,
  credential: PortalCredentialSigner,
) => {
  const nextMessage = () =>
    new Promise<MessageEvent>((resolve, reject) => {
      const onMessage = (event: MessageEvent) => {
        cleanup();
        resolve(event);
      };
      const onClose = (event: CloseEvent) => {
        cleanup();
        reject(
          new Error(
            event.reason || 'WebSocket closed during Portal authentication.',
          ),
        );
      };
      const cleanup = () => {
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('close', onClose);
      };
      socket.addEventListener('message', onMessage, { once: true });
      socket.addEventListener('close', onClose, { once: true });
    });

  const challenge = JSON.parse(
    String((await nextMessage()).data),
  ) as PortalAuthChallenge;
  if (challenge.type !== PORTAL_AUTH_CHALLENGE_TYPE) {
    throw new Error('Portal did not send an authentication challenge.');
  }
  socket.send(JSON.stringify({
    type: PORTAL_AUTH_RESPONSE_TYPE,
    credentialId: credential.credentialId,
    signature: await credential.sign(portalAuthChallengePayload(challenge)),
  }));
  const authenticated = JSON.parse(String((await nextMessage()).data)) as {
    type?: string;
  };
  if (authenticated.type !== PORTAL_AUTHENTICATED_TYPE) {
    throw new Error('Portal authentication did not complete.');
  }
};

export class RpcResponseError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

export class RpcSocket {
  readonly #socket: WebSocket;
  readonly #pending = new Map<
    string,
    { resolve(value: unknown): void; reject(cause: unknown): void }
  >();
  readonly notifications: JsonRpcMessage[] = [];
  #nextId = 0;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.onmessage = (event) => {
      const message = parseJsonRpcMessage(String(event.data));
      if (message.id !== undefined && message.method === undefined) {
        const pending = this.#pending.get(idKey(message.id));
        if (!pending) return;
        this.#pending.delete(idKey(message.id));
        if (message.error) {
          pending.reject(
            new RpcResponseError(
              message.error.code,
              message.error.message,
              message.error.data,
            ),
          );
        } else pending.resolve(message.result);
      } else {
        this.notifications.push(message);
      }
    };
    socket.onclose = (event) => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error(event.reason || 'WebSocket closed.'));
      }
      this.#pending.clear();
    };
  }

  static async open(url: string, credential: PortalCredentialSigner) {
    const socket = new WebSocket(url, PORTAL_WEBSOCKET_PROTOCOL);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(`Could not open ${url}.`));
    });
    await authentication(socket, credential);
    return new RpcSocket(socket);
  }

  request(method: string, params: unknown = {}) {
    const id = ++this.#nextId;
    const response = new Promise<unknown>((resolve, reject) => this.#pending.set(idKey(id), { resolve, reject }));
    this.#socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return response;
  }

  close() {
    this.#socket.close();
  }
}

export const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the acceptance condition.');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
