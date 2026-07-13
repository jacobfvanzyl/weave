import { assertEquals } from 'jsr:@std/assert@1.0.19';
import { IdempotentExecutionCache } from './idempotency.ts';

Deno.test('idempotent execution collapses concurrent and later retries', async () => {
  const cache = new IdempotentExecutionCache<number>();
  let executions = 0;
  const operation = async () => {
    executions += 1;
    await Promise.resolve();
    return executions;
  };

  assertEquals(
    await Promise.all([
      cache.execute('run:tool', operation),
      cache.execute('run:tool', operation),
    ]),
    [1, 1],
  );
  assertEquals(await cache.execute('run:tool', operation), 1);
  assertEquals(executions, 1);
});

Deno.test('calls without an idempotency key remain independent', async () => {
  const cache = new IdempotentExecutionCache<number>();
  let executions = 0;
  const operation = () => Promise.resolve(++executions);

  assertEquals(await cache.execute(undefined, operation), 1);
  assertEquals(await cache.execute(undefined, operation), 2);
});
