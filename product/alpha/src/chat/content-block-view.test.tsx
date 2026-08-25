import { describe, expect, it } from 'vitest';
import { coalesceContentBlocks } from './content-block-view';

describe('coalesceContentBlocks', () => {
  it('joins adjacent streamed text while preserving rich-content boundaries', () => {
    expect(coalesceContentBlocks([
      { type: 'text', text: 'A **streamed' },
      { type: 'text', text: ' message**' },
      { type: 'image', mimeType: 'image/png', data: 'AA==' },
      { type: 'text', text: 'After' },
      { type: 'text', text: ' image' },
    ])).toEqual([
      { type: 'text', text: 'A **streamed message**' },
      { type: 'image', mimeType: 'image/png', data: 'AA==' },
      { type: 'text', text: 'After image' },
    ]);
  });
});
