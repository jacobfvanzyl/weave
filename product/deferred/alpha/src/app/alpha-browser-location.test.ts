import { describe, expect, it } from 'vitest';
import { resolveAlphaBrowserLocation } from './alpha-browser-location';

describe('resolveAlphaBrowserLocation', () => {
  it('keeps absolute HTTP(S) addresses and normalizes schemeless domains to HTTPS', () => {
    expect(resolveAlphaBrowserLocation('https://example.org/docs')).toEqual({
      kind: 'navigate',
      url: 'https://example.org/docs',
    });
    expect(resolveAlphaBrowserLocation('example.org/docs')).toEqual({
      kind: 'navigate',
      url: 'https://example.org/docs',
    });
    expect(resolveAlphaBrowserLocation('example.org:8080/docs')).toEqual({
      kind: 'navigate',
      url: 'https://example.org:8080/docs',
    });
    expect(resolveAlphaBrowserLocation('bazzite:4173')).toEqual({
      kind: 'navigate',
      url: 'https://bazzite:4173/',
    });
    expect(resolveAlphaBrowserLocation('localhost:4174/ready')).toEqual({
      kind: 'navigate',
      url: 'https://localhost:4174/ready',
    });
  });

  it('turns non-address text into a percent-encoded Google query', () => {
    expect(resolveAlphaBrowserLocation('alpha tabs & webkit')).toEqual({
      kind: 'navigate',
      url: 'https://www.google.com/search?q=alpha%20tabs%20%26%20webkit',
    });
  });

  it('requires human handoff for supported external schemes', () => {
    expect(resolveAlphaBrowserLocation('mailto:hello@example.org')).toEqual({
      kind: 'external',
      url: 'mailto:hello@example.org',
    });
    expect(resolveAlphaBrowserLocation('tel:1234')).toEqual({
      kind: 'external',
      url: 'tel:1234',
    });
  });

  it('rejects empty and malformed explicit web addresses', () => {
    expect(resolveAlphaBrowserLocation('   ')).toEqual({ kind: 'empty' });
    expect(resolveAlphaBrowserLocation('https://')).toEqual({
      kind: 'invalid',
      message: 'Enter a valid web address or Google search.',
    });
  });
});
