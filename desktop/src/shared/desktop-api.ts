export type DesktopConnectionSettings = {
  mastraUrl: string;
  hasAuthToken: boolean;
};

export type DesktopConnectionInput = {
  mastraUrl: string;
  authToken?: string | null;
};

export type DesktopConnectionTestResult =
  | { ok: true; user: { id: string; name: string } }
  | { ok: false; status?: number; error: string };

export type WeaveDesktopBridge = {
  getConnectionSettings: () => Promise<DesktopConnectionSettings>;
  saveConnectionSettings: (input: DesktopConnectionInput) => Promise<DesktopConnectionSettings>;
  testConnection: (input?: DesktopConnectionInput) => Promise<DesktopConnectionTestResult>;
  openExternal: (url: string) => Promise<void>;
  getPlatform: () => 'darwin';
};
