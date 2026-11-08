import { expect, it } from 'vitest';
import { pairingLink, websocketUrl } from './storage';

it('turns the Serve URL into its WebSocket', () => {
  expect(websocketUrl('https://homelab.example.ts.net:7342')).toBe('wss://homelab.example.ts.net:7342');
  expect(websocketUrl('wss://homelab.example.ts.net:7342/')).toBe('wss://homelab.example.ts.net:7342');
  expect(websocketUrl('ws://127.0.0.1:7342')).toBe('ws://127.0.0.1:7342');
  expect(() => websocketUrl('ftp://example.com')).toThrow("isn't a weave Dispatcher's address");
});

it("reads weave dispatcher pair's link, and no other", () => {
  expect(pairingLink('weave://pair-dispatcher?url=wss%3A%2F%2Fhomelab.example.ts.net%3A7342&code=ABCDE12345')).toEqual({
    url: 'wss://homelab.example.ts.net:7342',
    code: 'ABCDE12345',
  });
  expect(pairingLink('weave://pair-dispatcher?url=wss%3A%2F%2Fhomelab')).toBeUndefined();
  // A Host's own pairing, which the app no longer makes (ADR 0030).
  expect(pairingLink('weave://pair?url=https%3A%2F%2Fmac.example.ts.net%3A7341&code=ABCDE12345')).toBeUndefined();
  expect(pairingLink('https://example.com/pair-dispatcher?url=x&code=y')).toBeUndefined();
});
