import { Preferences } from '@capacitor/preferences';

/**
 * What this device keeps about the Dispatcher it paired with (ADR 0030): the one pairing it has.
 * The key itself stays in the Keychain.
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
  /** The Keychain keys of the Hosts an earlier version of the app paired with one by one. */
  oldHostKeys(): Promise<string[]>;
  /** Forgets those pairings, once this device is paired with the Dispatcher. */
  forgetOldHosts(): Promise<void>;
};

const KEY = 'weave.dispatcher';
/** Where the app kept a record per Host before it paired with the Dispatcher alone (WVE-196). */
const OLD_HOSTS = 'weave.pairedHosts';

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

const keyIds = (value: unknown) => Array.isArray(value)
  ? value.flatMap((host: unknown) => typeof host === 'object' && host !== null && typeof (host as { keyId?: unknown }).keyId === 'string'
    ? [(host as { keyId: string }).keyId]
    : [])
  : [];

/** The pairing in the app's preferences (UserDefaults on iOS, localStorage in a browser). */
export const preferencesStorage: PairingStorage = {
  async load() {
    const record = parsed((await Preferences.get({ key: KEY })).value);
    return isRecord(record) ? record : undefined;
  },
  async save(record) {
    if (record) await Preferences.set({ key: KEY, value: JSON.stringify(record) });
    else await Preferences.remove({ key: KEY });
  },
  async oldHostKeys() {
    return keyIds(parsed((await Preferences.get({ key: OLD_HOSTS })).value));
  },
  async forgetOldHosts() {
    await Preferences.remove({ key: OLD_HOSTS });
  },
};

/** The pairing in memory, for tests, with the old Hosts' keys `oldHosts` names. */
export const memoryStorage = (record?: DispatcherRecord, oldHosts: string[] = []): PairingStorage & { current(): DispatcherRecord | undefined } => ({
  load: async () => record && structuredClone(record),
  save: async (next) => { record = next && structuredClone(next); },
  oldHostKeys: async () => [...oldHosts],
  forgetOldHosts: async () => { oldHosts = []; },
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
