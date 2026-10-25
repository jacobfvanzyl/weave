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
    for (const directive of ['default-src', 'script-src', 'style-src', 'img-src', 'media-src', 'font-src']) {
      for (const source of directives.get(directive) ?? []) {
        expect(["'self'", "'unsafe-inline'", 'data:', 'blob:'], `${directive} ${source}`).toContain(source);
      }
    }
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
  });

  it('reaches Hosts only over their WebSockets', () => {
    expect(directives.get('connect-src')).toEqual(["'self'", 'ws:', 'wss:']);
  });
});
