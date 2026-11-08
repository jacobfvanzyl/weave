import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generate, OUTPUT, SCHEMA, snapshotJson } from '../../scripts/protocol-types';
import { HOST_PROTOCOL } from './protocol';

const fixtures = resolve(SCHEMA, '..');

describe('the generated Host protocol types', () => {
  it('match the schema the Host keeps', async () => {
    const schema = snapshotJson(await readFile(SCHEMA, 'utf8'));
    const generated = await generate(schema as Parameters<typeof generate>[0]);
    // When this fails, run `bun scripts/protocol-types.ts`.
    expect(await readFile(OUTPUT, 'utf8')).toBe(generated);
  });

  it('name every method the golden fixtures use, the Host\'s or the Dispatcher\'s', async () => {
    const schema = snapshotJson(await readFile(SCHEMA, 'utf8')) as {
      'x-weave-requests': Record<string, unknown>;
      'x-weave-notifications': Record<string, unknown>;
      'x-weave-dispatcher-requests': Record<string, unknown>;
      'x-weave-dispatcher-notifications': Record<string, unknown>;
    };
    // `devices/*` are the Dispatcher's alone since Hosts stopped pairing devices (WVE-197).
    const methods = new Set([
      'x-weave-requests',
      'x-weave-notifications',
      'x-weave-dispatcher-requests',
      'x-weave-dispatcher-notifications',
    ].flatMap((table) => Object.keys(schema[table as keyof typeof schema])));
    const files = (await readdir(fixtures)).filter((name) => name.startsWith('wire__'));
    expect(files.length).toBeGreaterThan(50);
    const unknown: string[] = [];
    for (const file of files) {
      const message = snapshotJson(await readFile(resolve(fixtures, file), 'utf8')) as Record<string, unknown>;
      // Messages are `{method, params}`; the rest are types on their own, such as an `auth`.
      if (typeof message.method === 'string' && 'params' in message && !methods.has(message.method)) unknown.push(`${file}: ${message.method}`);
    }
    expect(unknown).toEqual([]);
  });

  it('carry the protocol\'s constants', () => {
    expect(HOST_PROTOCOL.protocol.version).toBe(3);
    expect(HOST_PROTOCOL.websocket.closeRevoked).toBe(4000);
    expect(HOST_PROTOCOL.errors.notTarget).toBe(-32070);
  });
});
