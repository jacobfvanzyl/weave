import { assertEquals, assertMatch } from 'jsr:@std/assert@1';
import { weaveChatChunkSchema, weaveChatMessageSchema } from '@weave/protocol';
import {
  normalizeWeaveChatChunk,
  normalizeWeaveChatMessage,
  normalizeWeaveChatThread,
  toJsonValue,
} from './chat-protocol.ts';

const chunkSamples: unknown[] = [
  { type: 'text-start', id: 'text-1' },
  { type: 'text-delta', id: 'text-1', delta: 'hello' },
  { type: 'text-end', id: 'text-1' },
  { type: 'reasoning-start', id: 'reasoning-1' },
  { type: 'reasoning-delta', id: 'reasoning-1', delta: 'checking' },
  { type: 'reasoning-end', id: 'reasoning-1' },
  { type: 'start', messageId: 'message-1', messageMetadata: { model: 'test' } },
  { type: 'finish', finishReason: 'stop', messageMetadata: { model: 'test' } },
  { type: 'start-step' },
  { type: 'finish-step' },
  { type: 'abort', reason: 'cancelled' },
  { type: 'error', errorText: 'failed' },
  { type: 'message-metadata', messageMetadata: { traceId: 'trace-1' } },
  { type: 'tool-input-start', toolCallId: 'tool-1', toolName: 'read' },
  { type: 'tool-input-delta', toolCallId: 'tool-1', inputTextDelta: '{"path":' },
  { type: 'tool-input-available', toolCallId: 'tool-1', toolName: 'read', input: { path: 'README.md' } },
  {
    type: 'tool-input-error',
    toolCallId: 'tool-1',
    toolName: 'read',
    input: { path: 1 },
    errorText: 'invalid input',
  },
  { type: 'tool-approval-request', approvalId: 'approval-1', toolCallId: 'tool-1' },
  { type: 'tool-output-available', toolCallId: 'tool-1', toolName: 'read', output: { ok: true } },
  { type: 'tool-output-error', toolCallId: 'tool-1', toolName: 'read', errorText: 'failed' },
  { type: 'tool-output-denied', toolCallId: 'tool-1' },
  { type: 'source-url', sourceId: 'source-1', url: 'https://example.com', title: 'Example' },
  { type: 'source-document', sourceId: 'source-2', mediaType: 'text/plain', title: 'Document' },
  { type: 'file', url: 'data:text/plain;base64,SGVsbG8=', mediaType: 'text/plain' },
  { type: 'data-custom-state', id: 'custom-1', data: { enabled: true }, transient: true },
];

Deno.test('chat normalization accepts every Weave chunk category', () => {
  for (const sample of chunkSamples) {
    const normalized = normalizeWeaveChatChunk(sample);
    weaveChatChunkSchema.parse(normalized);
    assertEquals(normalized, sample);
  }
});

Deno.test('chat normalization adapts legacy aliases and unsupported upstream chunks', () => {
  assertEquals(
    normalizeWeaveChatChunk({
      type: 'tool-call',
      toolCallId: 'tool-1',
      toolName: 'read',
      args: { path: 'README.md' },
    }),
    {
      type: 'tool-input-available',
      toolCallId: 'tool-1',
      toolName: 'read',
      input: { path: 'README.md' },
    },
  );
  assertEquals(normalizeWeaveChatChunk({ type: 'step-start' }), { type: 'start-step' });

  const unsupported = normalizeWeaveChatChunk({ type: 'provider-secret-event', value: 1 });
  assertEquals(unsupported.type, 'data-upstream-unsupported');
  if (!('data' in unsupported)) throw new Error('expected unsupported data chunk');
  assertEquals((unsupported.data as Record<string, unknown>).upstreamType, 'provider-secret-event');
});

Deno.test('chat normalization makes dynamic data JSON-safe', () => {
  const cyclic: Record<string, unknown> = { valid: true, missing: undefined, value: 1n };
  cyclic.self = cyclic;
  assertEquals(toJsonValue(cyclic), { valid: true, value: '1' });
  assertEquals(
    normalizeWeaveChatChunk({ type: 'error', error: new Error('provider failed') }),
    { type: 'error', errorText: 'provider failed' },
  );
});

Deno.test('thread normalization converts Mastra dates and strips undeclared fields', () => {
  assertEquals(
    normalizeWeaveChatThread({
      id: 'thread-1',
      title: 'Thread',
      resourceId: 'resource-1',
      createdAt: new Date('2026-07-15T06:00:00.000Z'),
      updatedAt: new Date('2026-07-15T07:00:00.000Z'),
      metadata: { mode: 'plain', missing: undefined },
      providerInternal: true,
    }),
    {
      id: 'thread-1',
      title: 'Thread',
      resourceId: 'resource-1',
      createdAt: '2026-07-15T06:00:00.000Z',
      updatedAt: '2026-07-15T07:00:00.000Z',
      metadata: { mode: 'plain' },
    },
  );
});

Deno.test('message normalization produces stable Weave-owned messages', () => {
  const message = normalizeWeaveChatMessage({
    id: 'message-1',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Done.', ignored: undefined },
      { type: 'tool-call', toolCallId: 'tool-1', toolName: 'read', args: { path: 'README.md' } },
      { type: 'provider-private-part', value: true },
    ],
    metadata: { traceId: 'trace-1', ignored: undefined },
  });
  weaveChatMessageSchema.parse(message);
  assertEquals(message.parts[0], { type: 'text', text: 'Done.' });
  assertEquals(message.parts[1], {
    type: 'tool-read',
    toolCallId: 'tool-1',
    state: 'input-available',
    input: { path: 'README.md' },
  });
  assertMatch(message.parts[2].type, /^data-upstream-unsupported$/);
  assertEquals(message.metadata, { traceId: 'trace-1' });
});
