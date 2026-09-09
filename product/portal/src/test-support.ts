import { test as bunTest } from 'bun:test';
import nodeAssert from 'node:assert/strict';
export function assert(value: unknown, message?: string): asserts value { nodeAssert(value, message ? new Error(message) : undefined); }
export function assertEquals(actual: unknown, expected: unknown, message?: string) { nodeAssert.deepStrictEqual(actual, expected, message ? new Error(message) : undefined); }
export function assertNotEquals(actual: unknown, expected: unknown, message?: string) { nodeAssert.notDeepStrictEqual(actual, expected, message ? new Error(message) : undefined); }
export function assertExists<T>(value: T): asserts value is NonNullable<T> { assert(value !== undefined && value !== null); }
export function assertStringIncludes(value: string, part: string) { assert(value.includes(part), `Expected ${JSON.stringify(value)} to include ${JSON.stringify(part)}`); }
type ExpectedError<T extends Error = Error> = (new (...args: any[]) => T) | { code: string };
function checkError(error: unknown, expected?: ExpectedError, message?: string) {
  assert(error instanceof Error);
  if (typeof expected === 'function') assert(error instanceof expected);
  else if (expected) nodeAssert.equal((error as NodeJS.ErrnoException).code, expected.code);
  if (message) assertStringIncludes(error.message, message);
  return error;
}
export async function assertRejects<T extends Error = Error>(fn: () => unknown, expected?: ExpectedError<T>, message?: string) {
  let error: unknown;
  try { await fn(); } catch (cause) { error = cause; }
  return checkError(error, expected, message) as T;
}
export function assertThrows(fn: () => unknown, expected?: ExpectedError, message?: string) {
  let error: unknown;
  try { fn(); } catch (cause) { error = cause; }
  return checkError(error, expected, message);
}
// Retain named scenarios while moving the runner to Bun. Resource lifetime is asserted by integration scenarios.
export function test(name: string | { name: string; ignore?: boolean; sanitizeResources?: boolean; sanitizeOps?: boolean; fn: () => unknown }, fn?: () => unknown) {
  const spec = typeof name === 'string' ? { name, fn: fn! } : name;
  (spec.ignore ? bunTest.skip : bunTest)(spec.name, async () => { await spec.fn(); }, 20_000);
}
