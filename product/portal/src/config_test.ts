import { test } from './test-support.ts';
import { readText } from './host-files.ts';
import { assertEquals, assertThrows } from './test-support.ts';
import { parsePortalConfig } from './config.ts';

const base = {
  listen: { hostname: '127.0.0.1', port: 4122 },
  displayName: 'Test Portal',
  stateDirectory: '/tmp/weave-portal-state',
  executionContexts: [{ executionContextId: 'workspace', name: 'Workspace', path: '/tmp' }],
  agents: [{ agentId: 'agent', name: 'Agent', command: 'false' }],
};

test('Portal permits a loopback-only development listener without TLS', () => {
  const config = parsePortalConfig(base);
  assertEquals(config.listen, { hostname: '127.0.0.1', port: 4122 });
  assertEquals(config.allowedOrigins, []);
});

test('Portal can start without preconfigured projects', () => {
  assertEquals(parsePortalConfig({ ...base, executionContexts: [] }).executionContexts, []);
});

test('Portal requires TLS and an explicit origin policy for non-loopback listeners', () => {
  assertThrows(
    () => parsePortalConfig({ ...base, listen: { hostname: '0.0.0.0', port: 4122 } }),
    Error,
    'requires TLS',
  );
  assertThrows(
    () =>
      parsePortalConfig({
        ...base,
        listen: { hostname: '0.0.0.0', port: 4122 },
        tls: { certificateFile: '/tmp/cert.pem', privateKeyFile: '/tmp/key.pem' },
      }),
    Error,
    'allowedOrigins',
  );
});

test('Portal accepts TLS files and an explicit browser-origin policy', () => {
  const config = parsePortalConfig({
    ...base,
    listen: { hostname: '0.0.0.0', port: 4122 },
    tls: { certificateFile: '/tmp/cert.pem', privateKeyFile: '/tmp/key.pem' },
    allowedOrigins: ['capacitor://localhost'],
  });
  assertEquals(config.allowedOrigins, ['capacitor://localhost']);
});

test('Portal example permits every shipped Alpha host', async () => {
  const example = JSON.parse(
    await readText(new URL('../portal.config.example.json', import.meta.url)),
  ) as { allowedOrigins?: unknown };
  assertEquals(example.allowedOrigins, [
    'http://localhost:5174',
    'capacitor://localhost',
    'weave://app',
  ]);
});
