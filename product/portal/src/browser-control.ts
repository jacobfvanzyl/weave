import {
  type BrowserAddress,
  type BrowserControlCommand,
  type BrowserControlErrorCode,
  type BrowserControlInvokeParams,
  type BrowserControlInvokeResult,
  type BrowserScreenshotArtifact,
  type BrowserProviderLease,
  type BrowserProviderOffer,
  parseBrowserControlInvokeResult,
} from '@weave/product-protocol';

export type BrowserHostConnection = {
  connectionId: string;
  invoke(params: BrowserControlInvokeParams, signal: AbortSignal): Promise<unknown>;
};

type Provider = {
  principalId: string;
  connection: BrowserHostConnection;
  lease: BrowserProviderLease;
  offer: BrowserProviderOffer;
  queue: Promise<void>;
  active?: AbortController;
  pending: number;
};

export type BrowserControlAuditEvent = {
  event: 'browser.control.attached' | 'browser.control.detached' | 'browser.control.completed' | 'browser.control.failed';
  timestamp: string;
  principalId?: string;
  operation?: string;
  address?: BrowserAddress;
  outcome?: 'succeeded' | 'failed';
  errorCode?: BrowserControlErrorCode;
  durationMs?: number;
};

export type BrowserControlBrokerOptions = {
  audit?: (event: BrowserControlAuditEvent) => void;
  maxPendingPerProvider?: number;
  screenshotInlineBytes?: number;
  externalizeScreenshot?: (
    data: Uint8Array,
    metadata: { requestId: string; address: BrowserAddress; sizeBytes: number },
  ) => Promise<BrowserScreenshotArtifact>;
};

export class BrowserControlError extends Error {
  readonly data: {
    domain: 'browser-control';
    code: BrowserControlErrorCode;
    retryable: boolean;
  };

  constructor(code: BrowserControlErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'BrowserControlError';
    this.data = { domain: 'browser-control', code, retryable };
  }
}

const sameAddress = (left: BrowserAddress, right: BrowserAddress) =>
  left.hostId === right.hostId && left.threadId === right.threadId &&
  left.clientId === right.clientId && left.tabId === right.tabId;

export class BrowserControlBroker {
  readonly #providersByThread = new Map<string, Provider>();
  readonly #providersByLease = new Map<string, Provider>();

  constructor(
    readonly hostId: string,
    readonly now: () => Date = () => new Date(),
    readonly leaseDurationMs = 15 * 60_000,
    readonly options: BrowserControlBrokerOptions = {},
  ) {}

  attach(
    principalId: string,
    threadId: string,
    offer: BrowserProviderOffer,
    connection: BrowserHostConnection,
  ): BrowserProviderLease {
    const existing = this.#providersByThread.get(threadId);
    if (existing) this.detach(existing.lease.leaseId);
    const lease: BrowserProviderLease = {
      leaseId: crypto.randomUUID(),
      address: { hostId: this.hostId, threadId, clientId: offer.clientId, tabId: offer.tabId },
      generation: offer.generation,
      controlRevision: offer.controlRevision,
      expiresAt: new Date(this.now().getTime() + this.leaseDurationMs).toISOString(),
    };
    const provider: Provider = { principalId, connection, lease, offer, queue: Promise.resolve(), pending: 0 };
    this.#providersByThread.set(threadId, provider);
    this.#providersByLease.set(lease.leaseId, provider);
    this.#audit({
      event: 'browser.control.attached',
      timestamp: this.now().toISOString(),
      principalId,
      address: lease.address,
    });
    return structuredClone(lease);
  }

  detach(leaseId: string) {
    const provider = this.#providersByLease.get(leaseId);
    if (!provider) return false;
    this.#providersByLease.delete(leaseId);
    if (this.#providersByThread.get(provider.lease.address.threadId) === provider) {
      this.#providersByThread.delete(provider.lease.address.threadId);
    }
    provider.active?.abort(new BrowserControlError('LEASE_REVOKED', 'Browser control was revoked.'));
    this.#audit({
      event: 'browser.control.detached',
      timestamp: this.now().toISOString(),
      principalId: provider.principalId,
      address: provider.lease.address,
    });
    return true;
  }

  detachConnection(connectionId: string) {
    for (const provider of [...this.#providersByLease.values()]) {
      if (provider.connection.connectionId === connectionId) this.detach(provider.lease.leaseId);
    }
  }

  status(threadId: string) {
    const provider = this.#providersByThread.get(threadId);
    return provider ? structuredClone(provider.lease) : undefined;
  }

  statusForLease(leaseId: string) {
    const provider = this.#providersByLease.get(leaseId);
    return provider ? { principalId: provider.principalId, lease: structuredClone(provider.lease) } : undefined;
  }

  async invoke(
    threadId: string,
    command: BrowserControlCommand,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<BrowserControlInvokeResult> {
    const started = this.now().getTime();
    const provider = this.#providersByThread.get(threadId);
    const operation = command.kind === 'see'
      ? command.url ? 'navigate' : 'observe'
      : command.action.kind;
    try {
      const result = await this.#invoke(threadId, command, options);
      this.#audit({
        event: 'browser.control.completed',
        timestamp: this.now().toISOString(),
        principalId: provider?.principalId,
        address: provider?.lease.address,
        operation,
        outcome: 'succeeded',
        durationMs: Math.max(0, this.now().getTime() - started),
      });
      return result;
    } catch (cause) {
      this.#audit({
        event: 'browser.control.failed',
        timestamp: this.now().toISOString(),
        principalId: provider?.principalId,
        address: provider?.lease.address,
        operation,
        outcome: 'failed',
        errorCode: cause instanceof BrowserControlError ? cause.data.code : 'HOST_DISCONNECTED',
        durationMs: Math.max(0, this.now().getTime() - started),
      });
      throw cause;
    }
  }

  async #invoke(
    threadId: string,
    command: BrowserControlCommand,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<BrowserControlInvokeResult> {
    const provider = this.#providersByThread.get(threadId);
    if (!provider) throw new BrowserControlError('NOT_ATTACHED', 'No visible Browser is attached to this Thread.');
    if (Date.parse(provider.lease.expiresAt) <= this.now().getTime()) {
      this.detach(provider.lease.leaseId);
      throw new BrowserControlError('LEASE_REVOKED', 'Browser control expired. Enable agent control again.');
    }
    if (!provider.offer.operations.includes(command.kind)) {
      throw new BrowserControlError('UNSUPPORTED', `The attached Browser does not support ${command.kind}.`);
    }
    const needsControl = command.kind === 'act' || Boolean(command.url);
    if (needsControl && !provider.offer.authorization.control) {
      throw new BrowserControlError('LEASE_REVOKED', 'Browser control permission is not granted.');
    }
    if (!needsControl && !provider.offer.authorization.observe) {
      throw new BrowserControlError('LEASE_REVOKED', 'Browser observe permission is not granted.');
    }
    const maxPending = this.options.maxPendingPerProvider ?? 4;
    if (provider.pending >= maxPending) {
      throw new BrowserControlError('BUSY', 'The visible Browser is busy. Try again with the newest view.', true);
    }
    provider.pending += 1;

    let release!: () => void;
    const previous = provider.queue;
    provider.queue = new Promise<void>((resolve) => release = resolve);
    await previous;
    try {
      if (this.#providersByLease.get(provider.lease.leaseId) !== provider) {
        throw new BrowserControlError('LEASE_REVOKED', 'Browser control was revoked.');
      }
      if (options.signal?.aborted) {
        throw new BrowserControlError('CANCELLED', 'Browser control was cancelled.', true);
      }
      const timeoutMs = Math.min(options.timeoutMs ?? 15_000, provider.offer.limits.maxDurationMs);
      const controller = new AbortController();
      provider.active = controller;
      const cancel = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener('abort', cancel, { once: true });
      let timeoutExpired = false;
      const timeout = setTimeout(() => {
        timeoutExpired = true;
        controller.abort(new BrowserControlError('TIMEOUT', 'Browser control timed out.', true));
      }, timeoutMs);
      const requestId = crypto.randomUUID();
      const params: BrowserControlInvokeParams = {
        requestId,
        leaseId: provider.lease.leaseId,
        address: provider.lease.address,
        generation: provider.lease.generation,
        expectedControlRevision: provider.lease.controlRevision,
        deadlineAt: new Date(this.now().getTime() + timeoutMs).toISOString(),
        command,
      };
      let raw: unknown;
      try {
        raw = await provider.connection.invoke(params, controller.signal);
      } catch (cause) {
        if (controller.signal.aborted) {
          if (controller.signal.reason instanceof BrowserControlError) throw controller.signal.reason;
          throw new BrowserControlError(
            timeoutExpired ? 'TIMEOUT' : 'CANCELLED',
            timeoutExpired ? 'Browser control timed out.' : 'Browser control was cancelled.',
            true,
          );
        }
        if (cause instanceof BrowserControlError) throw cause;
        throw new BrowserControlError('HOST_DISCONNECTED', 'The attached Browser disconnected.', true);
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', cancel);
        if (provider.active === controller) provider.active = undefined;
      }

      const result = parseBrowserControlInvokeResult(raw);
      if (this.#providersByLease.get(provider.lease.leaseId) !== provider) {
        throw new BrowserControlError('LEASE_REVOKED', 'Browser control was revoked.');
      }
      if (
        result.requestId !== requestId || result.leaseId !== provider.lease.leaseId ||
        !sameAddress(result.address, provider.lease.address) || result.view.tabId !== provider.lease.address.tabId ||
        result.view.generation !== provider.lease.generation
      ) {
        this.detach(provider.lease.leaseId);
        throw new BrowserControlError('STALE_TAB', 'The visible Browser session changed during control.');
      }
      if (result.view.controlRevision !== params.expectedControlRevision) {
        this.detach(provider.lease.leaseId);
        throw new BrowserControlError('CONTROL_INTERRUPTED', 'A person took over the visible Browser.');
      }
      if (result.view.elements.length > provider.offer.limits.maxElements) {
        throw new BrowserControlError('RESULT_TOO_LARGE', 'The Browser returned too many interactive elements.');
      }
      if (result.view.screenshot) {
        const screenshot = result.view.screenshot;
        const encoded = 'data' in screenshot ? screenshot.data : undefined;
        const bytes = encoded ? Math.floor(encoded.length * 3 / 4) : screenshot.artifact!.sizeBytes;
        if (bytes > provider.offer.limits.maxScreenshotBytes) {
          throw new BrowserControlError('RESULT_TOO_LARGE', 'The Browser screenshot exceeded its negotiated limit.');
        }
        if (
          encoded && bytes > (this.options.screenshotInlineBytes ?? 256_000) &&
          this.options.externalizeScreenshot
        ) {
          let binary: Uint8Array;
          try {
            binary = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
          } catch {
            throw new BrowserControlError('RESULT_TOO_LARGE', 'The Browser screenshot payload is invalid.');
          }
          result.view.screenshot = {
            mimeType: 'image/png',
            artifact: await this.options.externalizeScreenshot(binary, {
              requestId,
              address: provider.lease.address,
              sizeBytes: binary.byteLength,
            }),
          };
        }
      }
      const encodedBytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
      if (encodedBytes > provider.offer.limits.maxResultBytes) {
        throw new BrowserControlError('RESULT_TOO_LARGE', 'The Browser result exceeded its negotiated limit.');
      }
      provider.lease.controlRevision = result.view.controlRevision;
      return result;
    } finally {
      provider.pending -= 1;
      release();
    }
  }

  #audit(event: BrowserControlAuditEvent) {
    try {
      this.options.audit?.(structuredClone(event));
    } catch {
      // Audit persistence must not widen or crash the browser-control boundary.
    }
  }
}
