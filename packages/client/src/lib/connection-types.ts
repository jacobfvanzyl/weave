export type ConnectionStatus = 'checking' | 'connected' | 'disconnected';

export type ConnectionSettings = {
  mastraUrl: string;
  hasAuthToken: boolean;
};

export type ConnectionInput = {
  mastraUrl: string;
  authToken?: string | null;
};

export type ConnectionTestResult =
  | { ok: true; user: { id: string; name: string } }
  | { ok: false; status?: number; error: string };

export type ConnectionAdapter = {
  getSettings: () => Promise<ConnectionSettings> | ConnectionSettings;
  saveSettings: (input: ConnectionInput) => Promise<ConnectionSettings> | ConnectionSettings;
  testConnection: (input?: ConnectionInput) => Promise<ConnectionTestResult>;
  getClientAuthToken?: () => string | null | undefined;
};
