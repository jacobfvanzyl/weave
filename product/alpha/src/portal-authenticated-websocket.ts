import {
  parsePortalAuthenticated,
  parsePortalAuthChallenge,
  PORTAL_AUTH_RESPONSE_TYPE,
  PORTAL_WEBSOCKET_PROTOCOL,
  portalAuthChallengePayload,
} from '@weave/product-protocol';
import type { WebSocketConstructor } from '@agentclientprotocol/sdk/experimental/ws-client';
import type { PortalCredentialSigner } from '@/portal-credential';

class AuthenticatedPortalSocket extends EventTarget {
  static readonly CONNECTING = WebSocket.CONNECTING;
  static readonly OPEN = WebSocket.OPEN;
  static readonly CLOSING = WebSocket.CLOSING;
  static readonly CLOSED = WebSocket.CLOSED;

  readonly CONNECTING = WebSocket.CONNECTING;
  readonly OPEN = WebSocket.OPEN;
  readonly CLOSING = WebSocket.CLOSING;
  readonly CLOSED = WebSocket.CLOSED;
  readonly binaryType = 'blob';
  readonly bufferedAmount = 0;
  readonly extensions = '';
  readonly protocol = PORTAL_WEBSOCKET_PROTOCOL;
  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readyState: number = WebSocket.CONNECTING;
  readonly #socket: WebSocket;
  readonly #authenticationTimer: ReturnType<typeof setTimeout>;
  #authenticated = false;

  constructor(url: string | URL, credential: PortalCredentialSigner) {
    super();
    this.url = String(url);
    this.#socket = new WebSocket(url, PORTAL_WEBSOCKET_PROTOCOL);
    this.#authenticationTimer = setTimeout(() => {
      this.#emit('error', new ErrorEvent('error', { message: 'Portal authentication timed out.' }));
      this.#socket.close(1008, 'Portal authentication timed out.');
    }, 20_000);
    this.#socket.onmessage = (event) => void this.#receiveAuthentication(event, credential);
    this.#socket.onerror = () => this.#emit('error', new Event('error'));
    this.#socket.onclose = (event) => {
      clearTimeout(this.#authenticationTimer);
      this.readyState = WebSocket.CLOSED;
      this.#emit('close', new CloseEvent('close', { code: event.code, reason: event.reason, wasClean: event.wasClean }));
    };
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (!this.#authenticated) throw new DOMException('Portal authentication is not complete.', 'InvalidStateError');
    this.#socket.send(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = WebSocket.CLOSING;
    this.#socket.close(code, reason);
  }

  async #receiveAuthentication(event: MessageEvent, credential: PortalCredentialSigner) {
    try {
      const envelope = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (!this.#authenticated && !('principal' in envelope)) {
        const challenge = parsePortalAuthChallenge(envelope);
        if (challenge.hostId !== credential.hostId) throw new Error('Portal Host identity does not match this connection.');
        if (Date.parse(challenge.expiresAt) <= Date.now()) throw new Error('Portal authentication challenge expired.');
        this.#socket.send(JSON.stringify({
          type: PORTAL_AUTH_RESPONSE_TYPE,
          credentialId: credential.credentialId,
          signature: await credential.sign(portalAuthChallengePayload(challenge)),
        }));
        return;
      }
      const authenticated = parsePortalAuthenticated(envelope);
      if (authenticated.principal.credentialId !== credential.credentialId) {
        throw new Error('Portal authenticated a different credential.');
      }
      this.#authenticated = true;
      clearTimeout(this.#authenticationTimer);
      this.readyState = WebSocket.OPEN;
      this.#socket.onmessage = (message) =>
        this.#emit('message', new MessageEvent('message', { data: message.data }));
      this.#emit('open', new Event('open'));
    } catch (cause) {
      this.#emit('error', new ErrorEvent('error', { error: cause, message: cause instanceof Error ? cause.message : String(cause) }));
      this.#socket.close(1008, 'Portal authentication failed.');
    }
  }

  #emit(type: 'open' | 'message' | 'error' | 'close', event: Event) {
    this.dispatchEvent(event);
    const handler = this[`on${type}`];
    if (typeof handler === 'function') handler(event as never);
  }
}

export const authenticatedPortalWebSocket = (
  credential: PortalCredentialSigner,
): WebSocketConstructor =>
  class extends AuthenticatedPortalSocket {
    constructor(url: string | URL) {
      super(url, credential);
    }
  } as unknown as WebSocketConstructor;
