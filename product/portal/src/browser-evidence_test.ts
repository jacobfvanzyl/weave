import { assertEquals } from 'jsr:@std/assert@1.0.18';
import { join } from 'jsr:@std/path@1.1.2';
import { BrowserControlEvidenceStore } from './browser-evidence.ts';

Deno.test('Browser control evidence is private, bounded, and redacted', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-browser-evidence-' });
  try {
    const store = new BrowserControlEvidenceStore(root, () => new Date('2026-08-30T00:00:00.000Z'));
    store.audit({
      event: 'browser.control.completed',
      timestamp: '2026-08-30T00:00:00.000Z',
      principalId: 'local-controller',
      operation: 'fill',
      address: { hostId: 'host', threadId: 'thread', clientId: 'client', tabId: 'tab' },
      outcome: 'succeeded',
      durationMs: 12,
    });
    const artifact = await store.storeScreenshot(new Uint8Array([1, 2, 3]), 'request');
    const auditPath = join(root, 'browser-control-audit.jsonl');
    const audit = await Deno.readTextFile(auditPath);
    assertEquals(JSON.parse(audit).operation, 'fill');
    assertEquals(audit.includes('page text'), false);
    assertEquals((await Deno.stat(auditPath)).mode! & 0o777, 0o600);
    const artifacts: string[] = [];
    for await (const entry of Deno.readDir(join(root, 'browser-artifacts'))) artifacts.push(entry.name);
    assertEquals(artifacts.length, 1);
    assertEquals((await Deno.stat(join(root, 'browser-artifacts', artifacts[0]!))).mode! & 0o777, 0o600);
    assertEquals(artifact.uri.startsWith('weave-browser-artifact://'), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Browser control evidence rotates audits and deletes expired artifacts', async () => {
  const root = await Deno.makeTempDir({ prefix: 'weave-browser-retention-' });
  try {
    const store = new BrowserControlEvidenceStore(root, () => new Date(), 1, 1);
    const event = { event: 'browser.control.detached' as const, timestamp: new Date().toISOString() };
    store.audit(event);
    store.audit(event);
    assertEquals((await Deno.stat(join(root, 'browser-control-audit.jsonl.1'))).mode! & 0o777, 0o600);
    await store.storeScreenshot(new Uint8Array([1, 2, 3]), 'request');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const artifacts: string[] = [];
    for await (const entry of Deno.readDir(join(root, 'browser-artifacts'))) artifacts.push(entry.name);
    assertEquals(artifacts, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
