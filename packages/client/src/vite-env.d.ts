/// <reference types="vite/client" />

declare const __WEAVE_AUTH_TOKEN__: string | null | undefined;
declare const __WEAVE_CLIENT_APP__: string | null | undefined;

declare module '@capacitor/preferences' {
  export const Preferences: {
    get(options: { key: string }): Promise<{ value: string | null }>;
    set(options: { key: string; value: string }): Promise<void>;
  };
}
