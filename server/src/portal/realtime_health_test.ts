import { portalRealtimeHealthResponse } from './realtime.ts';

const assertEquals = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

Deno.test('Portal realtime health is public on GET /health only', async () => {
  const response = portalRealtimeHealthResponse(new Request('http://localhost:4112/health'));
  assertEquals(response?.status, 200);
  assertEquals(await response?.json(), { ok: true });
  assertEquals(
    portalRealtimeHealthResponse(new Request('http://localhost:4112/health', { method: 'POST' })),
    undefined,
  );
  assertEquals(portalRealtimeHealthResponse(new Request('http://localhost:4112/portals/connect')), undefined);
});
