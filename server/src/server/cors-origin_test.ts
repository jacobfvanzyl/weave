import { isAllowedCorsOrigin } from './cors-origin.ts';

const assertEquals = (actual: unknown, expected: unknown) => {
  if (actual !== expected) throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
};

Deno.test('CORS allows the Capacitor iOS app origin', () => {
  assertEquals(isAllowedCorsOrigin('capacitor://localhost', new Set()), true);
});

Deno.test('CORS keeps other custom-scheme origins denied', () => {
  assertEquals(isAllowedCorsOrigin('capacitor://attacker.example', new Set()), false);
  assertEquals(isAllowedCorsOrigin('ionic://localhost', new Set()), false);
});

Deno.test('CORS preserves configured, loopback, and local-network origins', () => {
  const configured = new Set(['https://weave.example']);

  assertEquals(isAllowedCorsOrigin('https://weave.example', configured), true);
  assertEquals(isAllowedCorsOrigin('http://localhost:5173', configured), true);
  assertEquals(isAllowedCorsOrigin('http://192.168.1.20:5173', configured), true);
  assertEquals(isAllowedCorsOrigin('https://weave.local', configured), true);
  assertEquals(isAllowedCorsOrigin('https://example.com', configured), false);
});
