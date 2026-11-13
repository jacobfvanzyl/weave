/**
 * What this device keeps about the Dispatcher it paired with (ADR 0030): the one pairing it has.
 * The key itself stays where the device keeps it: the Secure Enclave, in the app's shell.
 */
export type DispatcherRecord = {
  /** The Dispatcher's own id, which its challenges are bound to. */
  dispatcherId: string;
  /** What it calls itself: its computer's name. */
  name: string;
  /** Its WebSocket, `wss://` through its Tailscale Serve entry. */
  url: string;
  /** What the Dispatcher calls this device. */
  deviceId: string;
  /** The device key's name in the Keychain. */
  keyId: string;
  /** The Hosts it last listed, shown while it can't be reached. */
  hosts?: { id: string; name: string }[];
};

export type PairingStorage = {
  load(): Promise<DispatcherRecord | undefined>;
  /** Keeps the pairing, or with none forgets it. */
  save(record: DispatcherRecord | undefined): Promise<void>;
};

const KEY = 'weave.dispatcher';

const parsed = (value: string | null): unknown => {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is DispatcherRecord =>
  typeof value === 'object' && value !== null
  && ['dispatcherId', 'name', 'url', 'deviceId', 'keyId'].every((key) => typeof (value as Record<string, unknown>)[key] === 'string');

/**
 * The pairing in the page's own storage, for a browser: `localStorage`, or nothing kept where the
 * browser gives none.
 */
export const pageStorage: PairingStorage = {
  async load() {
    try {
      const record = parsed(localStorage.getItem(KEY));
      return isRecord(record) ? record : undefined;
    } catch {
      return undefined;
    }
  },
  async save(record) {
    try {
      if (record) localStorage.setItem(KEY, JSON.stringify(record));
      else localStorage.removeItem(KEY);
    } catch {
      // A browser that keeps nothing pairs again after a reload, as it does for its key.
    }
  },
};

/** The pairing in memory, for tests. */
export const memoryStorage = (record?: DispatcherRecord): PairingStorage & { current(): DispatcherRecord | undefined } => ({
  load: async () => record && structuredClone(record),
  save: async (next) => { record = next && structuredClone(next); },
  current: () => record && structuredClone(record),
});

/**
 * The WebSocket URL for what `weave pair` gives: its link carries the Dispatcher's
 * WebSocket, `wss://…`, or a Serve URL, `https://…`, whose WebSocket is `wss://…` on the same host
 * and port.
 */
export function websocketUrl(url: string): string {
  const parsed = new URL(url.trim());
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  else if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') throw new Error(`${url} isn't a weave Dispatcher's address.`);
  return parsed.toString().replace(/\/$/, '');
}

/** `weave pair`'s link: `weave://pair-dispatcher?url=…&code=…`. */
export function pairingLink(link: string): { url: string; code: string } | undefined {
  try {
    const parsed = new URL(link);
    const target = parsed.host || parsed.pathname.replace(/^\/+/, '');
    if (parsed.protocol !== 'weave:' || target !== 'pair-dispatcher') return undefined;
    const url = parsed.searchParams.get('url');
    const code = parsed.searchParams.get('code');
    return url && code ? { url, code } : undefined;
  } catch {
    return undefined;
  }
}
