import { Preferences } from '@capacitor/preferences';

/** What this device keeps about a Host it paired with. The key itself stays in the Keychain. */
export type PairedHostRecord = {
  /** The Host's own id (`host.id`), which its challenges are bound to. */
  hostId: string;
  /** What this device calls the Host: the URL's host name, until the person renames it. */
  name: string;
  /** The Host's WebSocket, `wss://` through Tailscale Serve. */
  url: string;
  /** What the Host calls this device. */
  deviceId: string;
  /** The device key's name in the Keychain. */
  keyId: string;
};

export type HostStorage = {
  load(): Promise<PairedHostRecord[]>;
  save(hosts: PairedHostRecord[]): Promise<void>;
};

const KEY = 'weave.pairedHosts';

/** Paired Hosts in the app's preferences (UserDefaults on iOS, localStorage in a browser). */
export const preferencesStorage: HostStorage = {
  async load() {
    const { value } = await Preferences.get({ key: KEY });
    if (!value) return [];
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed as PairedHostRecord[] : [];
    } catch {
      return [];
    }
  },
  async save(hosts) {
    await Preferences.set({ key: KEY, value: JSON.stringify(hosts) });
  },
};

/** Paired Hosts in memory, for tests. */
export const memoryStorage = (hosts: PairedHostRecord[] = []): HostStorage => ({
  load: async () => structuredClone(hosts),
  save: async (next) => { hosts = structuredClone(next); },
});

/**
 * The WebSocket URL for what `weave pair` gives: its link carries the Serve URL, `https://…`,
 * whose WebSocket is `wss://…` on the same host and port.
 */
export function websocketUrl(url: string): string {
  const parsed = new URL(url.trim());
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  else if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') throw new Error(`${url} isn't a weave Host's address.`);
  return parsed.toString().replace(/\/$/, '');
}

/** `weave pair`'s link: `weave://pair?url=…&code=…`. */
export function pairingLink(link: string): { url: string; code: string } | undefined {
  try {
    const parsed = new URL(link);
    if (parsed.protocol !== 'weave:' || (parsed.host !== 'pair' && parsed.pathname.replace(/^\/+/, '') !== 'pair')) return undefined;
    const url = parsed.searchParams.get('url');
    const code = parsed.searchParams.get('code');
    return url && code ? { url, code } : undefined;
  } catch {
    return undefined;
  }
}
