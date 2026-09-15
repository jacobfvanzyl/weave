import { test, expect } from 'bun:test';
import { PassThrough } from 'node:stream';
import { CdpPipe, CdpPipeSession } from './browser-service/cdp-pipe.ts';
test('CDP pipe preserves fragmented Unicode, full errors, session events and isolates consumers', async () => {
  const input = new PassThrough(), output = new PassThrough(), pipe = new CdpPipe(input, output);
  let next = 0;
  input.on('data', chunk => {
    const request = JSON.parse(chunk.toString().slice(0, -1));
    const result = request.method === 'Target.attachToBrowserTarget' ? { sessionId: `root-${++next}` } : { text: '✓' };
    const encoded = Buffer.from(JSON.stringify({ id: request.id, result, sessionId: request.sessionId }) + '\0');
    output.write(encoded.subarray(0, encoded.length - 4)); output.write(encoded.subarray(encoded.length - 4));
  });
  try {
    const a = await CdpPipeSession.open(pipe), b = await CdpPipeSession.open(pipe);
    expect((await a.send({ id: 10, method: 'Runtime.evaluate' })).result).toEqual({ text: '✓' });
    output.write(JSON.stringify({ method: 'Target.attachedToTarget', sessionId: a.root, params: { sessionId: 'child', targetInfo: {} } }) + '\0');
    output.write(JSON.stringify({ method: 'Debugger.paused', sessionId: 'child', params: { reason: 'other' } }) + '\0');
    expect(a.events()).toHaveLength(2); expect(b.events()).toHaveLength(0);
    await expect(b.send({ id: 1, method: 'Debugger.resume', sessionId: 'child' })).rejects.toThrow('unavailable');
    await a.close(); expect((await b.send({ id: 12, method: 'Runtime.evaluate' })).id).toBe(12);
    pipe.close(); expect(() => b.events()).toThrow('closed'); await b.close();
  } finally { pipe.close(); input.destroy(); output.destroy(); }
});


test('streamed CDP preserves discovery events before and after command responses', async () => {
  const input = new PassThrough(), output = new PassThrough(), pipe = new CdpPipe(input, output);
  input.on('data', chunk => {
    const request = JSON.parse(chunk.toString().slice(0, -1));
    if (request.method === 'Target.setDiscoverTargets') {
      output.write([
        { method: 'Target.targetCreated', sessionId: 'root', params: { targetInfo: { targetId: 'page' } } },
        { id: request.id, sessionId: 'root', result: {} },
        { method: 'Target.targetInfoChanged', sessionId: 'root', params: { targetInfo: { targetId: 'page' } } },
      ].map(message => JSON.stringify(message) + '\0').join(''));
    } else output.write(JSON.stringify({ id: request.id, result: { sessionId: 'root' } }) + '\0');
  });
  try {
    const session = await CdpPipeSession.open(pipe);
    session.dispatch({ id: 42, method: 'Target.setDiscoverTargets', params: { discover: true } });
    expect(session.events()).toEqual([
      { method: 'Target.targetCreated', params: { targetInfo: { targetId: 'page' } } },
      { id: 42, result: {} },
      { method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 'page' } } },
    ]);
    await session.close();
  } finally { pipe.close(); input.destroy(); output.destroy(); }
});
