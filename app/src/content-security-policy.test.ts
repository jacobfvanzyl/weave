import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from './content-security-policy';

const directives = new Map(
  contentSecurityPolicy.split('; ').map((directive) => {
    const [name, ...sources] = directive.split(' ');
    return [name, sources] as const;
  }),
);

describe('contentSecurityPolicy', () => {
  it('loads nothing from another address, so nothing an agent names can be fetched', () => {
    for (const directive of ['default-src', 'style-src', 'img-src', 'media-src', 'font-src']) {
      for (const source of directives.get(directive) ?? []) {
        expect(["'self'", "'unsafe-inline'", 'data:', 'blob:'], `${directive} ${source}`).toContain(source);
      }
    }
    // The app's own scripts, and its own WebAssembly: the Mac's terminals (WVE-205).
    expect(directives.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
  });

  it("reaches Hosts only over their WebSockets, or on the Mac through its app's core", () => {
    expect(directives.get('connect-src')).toEqual(["'self'", 'ws:', 'wss:', 'ipc:', 'http://ipc.localhost']);
  });
});
