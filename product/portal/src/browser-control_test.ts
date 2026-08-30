import { assertEquals, assertRejects } from 'jsr:@std/assert@1.0.18';
import type { BrowserControlInvokeParams, BrowserProviderOffer } from '@weave/product-protocol';
import { BrowserControlBroker, BrowserControlError } from './browser-control.ts';

const offer = (overrides: Partial<BrowserProviderOffer> = {}): BrowserProviderOffer => ({
  version: 1,
  clientId: 'alpha-ipad',
  tabId: 'visible-tab',
  generation: 1,
  controlRevision: 0,
  platform: 'iPadOS',
  operations: ['see', 'act'],
  limits: { maxResultBytes: 64_000, maxScreenshotBytes: 32_000, maxElements: 20, maxDurationMs: 500 },
  ...overrides,
});

const resultFor = (params: BrowserControlInvokeParams, overrides: Record<string, unknown> = {}) => ({
  requestId: params.requestId,
  leaseId: params.leaseId,
  address: params.address,
  view: {
    id: 'view-1',
    tabId: params.address.tabId,
    generation: params.generation,
    controlRevision: params.expectedControlRevision,
    url: 'https://fixture.test/',
    title: 'Fixture',
    loading: false,
    viewport: { width: 800, height: 600 },
    text: 'Ready',
    elements: [{ ref: 'view-1:0', role: 'textbox', name: 'Message' }],
    warnings: [],
    ...overrides,
  },
});

Deno.test('BrowserControlBroker pins a Thread to its exact visible provider', async () => {
  const calls: BrowserControlInvokeParams[] = [];
  const broker = new BrowserControlBroker('host-1');
  const lease = broker.attach('principal-1', 'thread-1', offer(), {
    connectionId: 'connection-1',
    invoke: (params) => {
      calls.push(params);
      return Promise.resolve(resultFor(params));
    },
  });

  const result = await broker.invoke('thread-1', { kind: 'see' });
  assertEquals(lease.address, {
    hostId: 'host-1',
    threadId: 'thread-1',
    clientId: 'alpha-ipad',
    tabId: 'visible-tab',
  });
  assertEquals(calls[0]?.address, lease.address);
  assertEquals(result.view.controlRevision, 0);
  await assertRejects(
    () => broker.invoke('thread-2', { kind: 'see' }),
    BrowserControlError,
    'No visible Browser is attached',
  );
});

Deno.test('BrowserControlBroker revokes stale tabs and disconnected providers', async () => {
  const broker = new BrowserControlBroker('host-1');
  broker.attach('principal-1', 'thread-1', offer(), {
    connectionId: 'connection-1',
    invoke: (params) => Promise.resolve(resultFor(params, { tabId: 'replacement-tab' })),
  });
  await assertRejects(() => broker.invoke('thread-1', { kind: 'see' }), BrowserControlError, 'changed');
  await assertRejects(() => broker.invoke('thread-1', { kind: 'see' }), BrowserControlError, 'No visible Browser');

  broker.attach('principal-1', 'thread-1', offer(), {
    connectionId: 'connection-1',
    invoke: (params) => Promise.resolve(resultFor(params, { controlRevision: 1 })),
  });
  await assertRejects(() => broker.invoke('thread-1', { kind: 'see' }), BrowserControlError, 'took over');
  await assertRejects(() => broker.invoke('thread-1', { kind: 'see' }), BrowserControlError, 'No visible Browser');

  broker.attach('principal-1', 'thread-1', offer(), {
    connectionId: 'connection-2',
    invoke: (params) => Promise.resolve(resultFor(params)),
  });
  broker.detachConnection('connection-2');
  await assertRejects(() => broker.invoke('thread-1', { kind: 'see' }), BrowserControlError, 'No visible Browser');
});

Deno.test('BrowserControlBroker bounds results and propagates cancellation', async () => {
  const broker = new BrowserControlBroker('host-1');
  broker.attach(
    'principal-1',
    'thread-1',
    offer({
      limits: {
        maxResultBytes: 700,
        maxScreenshotBytes: 10,
        maxElements: 2,
        maxDurationMs: 500,
      },
    }),
    {
      connectionId: 'connection-1',
      invoke: (params) => Promise.resolve(resultFor(params, { text: 'x'.repeat(2_000) })),
    },
  );
  await assertRejects(() => broker.invoke('thread-1', { kind: 'see' }), BrowserControlError, 'negotiated limit');

  const controller = new AbortController();
  broker.attach('principal-1', 'thread-1', offer(), {
    connectionId: 'connection-1',
    invoke: (_params, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  });
  const pending = broker.invoke('thread-1', { kind: 'see' }, { signal: controller.signal });
  controller.abort();
  await assertRejects(() => pending, BrowserControlError, 'cancelled');

  let invocationSignal: AbortSignal | undefined;
  const lease = broker.attach('principal-1', 'thread-1', offer(), {
    connectionId: 'connection-1',
    invoke: (_params, signal) => {
      invocationSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  const revoked = broker.invoke('thread-1', { kind: 'see' });
  await Promise.resolve();
  broker.detach(lease.leaseId);
  assertEquals(invocationSignal?.aborted, true);
  await assertRejects(() => revoked, BrowserControlError, 'revoked');
});
