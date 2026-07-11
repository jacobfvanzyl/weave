import { assertMatchingObjectManifests, objectManifest } from './copy-object-store.ts';

const assertEquals = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

Deno.test('objectManifest sorts keys and preserves byte sizes', () => {
  assertEquals(
    objectManifest([{ Key: 'z', Size: 2 }, { Key: 'a', Size: 1 }, { Size: 99 }]),
    [{ key: 'a', size: 1 }, { key: 'z', size: 2 }],
  );
});

Deno.test('assertMatchingObjectManifests rejects count and size mismatches', () => {
  const source = [{ key: 'a', size: 1 }];
  assertMatchingObjectManifests(source, [{ key: 'a', size: 1 }]);

  let countError = '';
  try {
    assertMatchingObjectManifests(source, []);
  } catch (error) {
    countError = error instanceof Error ? error.message : String(error);
  }
  if (!countError.includes('count mismatch')) throw new Error(`Unexpected error: ${countError}`);

  let sizeError = '';
  try {
    assertMatchingObjectManifests(source, [{ key: 'a', size: 2 }]);
  } catch (error) {
    sizeError = error instanceof Error ? error.message : String(error);
  }
  if (!sizeError.includes('object mismatch')) throw new Error(`Unexpected error: ${sizeError}`);
});
