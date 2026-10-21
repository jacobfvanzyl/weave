import { expect, it } from 'vitest';
import { pairingLink, websocketUrl } from './storage';

it('turns the Serve URL into its WebSocket', () => {
  expect(websocketUrl('https://mac.example.ts.net:7341')).toBe('wss://mac.example.ts.net:7341');
  expect(websocketUrl('https://mac.example.ts.net:7341/')).toBe('wss://mac.example.ts.net:7341');
  expect(websocketUrl('ws://127.0.0.1:7341')).toBe('ws://127.0.0.1:7341');
  expect(() => websocketUrl('ftp://example.com')).toThrow("isn't a weave Host's address");
});

it('reads weave pair\'s link', () => {
  expect(pairingLink('weave://pair?url=https%3A%2F%2Fmac.example.ts.net%3A7341&code=ABCDE12345')).toEqual({
    url: 'https://mac.example.ts.net:7341',
    code: 'ABCDE12345',
  });
  expect(pairingLink('weave://pair?url=https%3A%2F%2Fmac')).toBeUndefined();
  expect(pairingLink('https://example.com/pair?url=x&code=y')).toBeUndefined();
});
