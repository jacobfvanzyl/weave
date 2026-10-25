/**
 * The built app's Content Security Policy: everything comes from the app itself, except the Hosts'
 * WebSockets. It backs up weave's rule that agent text makes the app fetch nothing without consent:
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
  // Hosts are paired by address, so any WebSocket.
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');
