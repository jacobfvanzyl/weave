/// <reference types="vite/client" />

declare const __WEAVE_AUTH_TOKEN__: string | null | undefined;

declare module 'ghostty-web/ghostty-vt.wasm?url' {
  const url: string;
  export default url;
}

declare module '@capacitor/preferences' {
  export const Preferences: {
    get(options: { key: string }): Promise<{ value: string | null }>;
    set(options: { key: string; value: string }): Promise<void>;
  };
}
