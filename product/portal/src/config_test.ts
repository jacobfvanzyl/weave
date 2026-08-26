import { assertEquals, assertThrows } from 'jsr:@std/assert@1.0.14';
import { parsePortalConfig } from './config.ts';

const base = {
  listen: { hostname: '127.0.0.1', port: 4122 },
  displayName: 'Test Portal',
  stateDirectory: '/tmp/weave-portal-state',
  workspaces: [{ workspaceId: 'workspace', name: 'Workspace', path: '/tmp' }],
  agents: [{ agentId: 'agent', name: 'Agent', command: 'false' }],
};

Deno.test('Portal permits a loopback-only development listener without TLS', () => {
  const config = parsePortalConfig(base);
  assertEquals(config.listen, { hostname: '127.0.0.1', port: 4122 });
  assertEquals(config.allowedOrigins, []);
});

Deno.test('Portal requires TLS and an explicit origin policy for non-loopback listeners', () => {
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
  assertThrows(
    () =>
      parsePortalConfig({
        ...base,
        listen: { hostname: '0.0.0.0', port: 4122 },
        publicUrl: 'ws://test.example:4122',
        tls: { certificateFile: '/tmp/cert.pem', privateKeyFile: '/tmp/key.pem' },
        allowedOrigins: [],
      }),
    Error,
    'must use wss',
  );
});

Deno.test('Portal accepts an explicit WSS endpoint and TLS files', () => {
  const config = parsePortalConfig({
    ...base,
    listen: { hostname: '0.0.0.0', port: 4122 },
    publicUrl: 'wss://test.example:4122/rpc?ignored=true',
    tls: { certificateFile: '/tmp/cert.pem', privateKeyFile: '/tmp/key.pem' },
    allowedOrigins: ['capacitor://localhost'],
  });
  assertEquals(config.publicUrl, 'wss://test.example:4122');
  assertEquals(config.allowedOrigins, ['capacitor://localhost']);
});
