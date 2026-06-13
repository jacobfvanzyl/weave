import { assertEquals } from 'jsr:@std/assert@1.0.19';
import { getContainedVideoRect, normalizeVideoPoint } from '../../packages/client/src/lib/window-stream-control.ts';

Deno.test('window stream control maps points inside letterboxed video rect', () => {
  const container = { left: 0, top: 0, width: 1000, height: 1000 };
  const rect = getContainedVideoRect(container, 1920, 1080);
  assertEquals(rect, { left: 0, top: 218.75, width: 1000, height: 562.5 });
  assertEquals(normalizeVideoPoint(container, 1920, 1080, 500, 500), { x: 0.5, y: 0.5 });
  assertEquals(normalizeVideoPoint(container, 1920, 1080, 500, 100), undefined);
});

Deno.test('window stream control maps points inside pillarboxed video rect', () => {
  const container = { left: 10, top: 20, width: 1000, height: 500 };
  const rect = getContainedVideoRect(container, 500, 1000);
  assertEquals(rect, { left: 385, top: 20, width: 250, height: 500 });
  assertEquals(normalizeVideoPoint(container, 500, 1000, 510, 270), { x: 0.5, y: 0.5 });
  assertEquals(normalizeVideoPoint(container, 500, 1000, 100, 270), undefined);
});
