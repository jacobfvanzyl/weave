/**
 * The built app's Content Security Policy: everything comes from the app itself, except the
 * Dispatcher's WebSockets, through which it reaches every Host. It backs up weave's rule that agent text makes the app fetch nothing without consent:
 * whatever a renderer would load from an address an agent wrote (an image, a font, a stylesheet),
 * the web view refuses. ACP images and audio arrive as `data:` URLs.
 */
export const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  // Mermaid's SVG carries a `<style>`, and Streamdown and KaTeX set inline styles.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  // The Dispatcher is paired by address, so any WebSocket. On the Mac, the page reaches its Rust
  // core over Tauri's IPC, which isn't the network (ADR 0032).
  "connect-src 'self' ws: wss: ipc: http://ipc.localhost",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');
