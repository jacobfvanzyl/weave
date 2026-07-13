import { assertEquals } from 'jsr:@std/assert@1';
import { isRpcInitializeRequest } from './gateway.ts';

Deno.test('RPC gateway recognizes only an initialize request as the first frame', () => {
  assertEquals(
    isRpcInitializeRequest(JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      method: 'initialize',
      params: {},
    })),
    true,
  );
  assertEquals(
    isRpcInitializeRequest(JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      method: 'owner.get',
    })),
    false,
  );
  assertEquals(
    isRpcInitializeRequest(JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
    })),
    false,
  );
  assertEquals(isRpcInitializeRequest('not json'), false);
  assertEquals(isRpcInitializeRequest(JSON.stringify([])), false);
});
