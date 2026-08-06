import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1.0.19';
import { stripHistoricalImagePrompt } from './current-turn-image-processor.ts';

const imageMessage = {
  role: 'user',
  content: [
    { type: 'text', text: 'Inspect this screenshot' },
    { type: 'image', image: 'https://weave.local/attachments/att_visual', mimeType: 'image/png' },
  ],
};

Deno.test('current image is sent once and becomes a durable re-view reference on later steps', () => {
  assertEquals(stripHistoricalImagePrompt([imageMessage], { stepNumber: 0 }), [imageMessage]);
  const later = stripHistoricalImagePrompt([imageMessage], { stepNumber: 1 });
  const reference = (later[0].content as Array<{ text?: string }>)[1]?.text ?? '';
  assertStringIncludes(reference, 'att_visual');
  assertStringIncludes(reference, 'view_attachment');
});

Deno.test('historical images are references while the latest current-turn image remains visible', () => {
  const latest = { ...imageMessage, content: [{ type: 'image', image: 'https://weave.local/attachments/att_latest' }] };
  const prompt = stripHistoricalImagePrompt([imageMessage, latest], { stepNumber: 0 });
  assertStringIncludes(String((prompt[0].content as Array<{ text?: string }>)[1]?.text), 'att_visual');
  assertEquals(prompt[1], latest);
});

Deno.test('provider file URLs retain their durable attachment id on later agentic steps', () => {
  const providerPrompt = [{
    role: 'user',
    content: [
      { type: 'text', text: 'Inspect this screenshot' },
      {
        type: 'file',
        data: new URL('https://weave.local/attachments/att_provider_file'),
        mediaType: 'image/png',
        filename: 'screenshot.png',
      },
    ],
  }];

  const later = stripHistoricalImagePrompt(providerPrompt, { stepNumber: 1 });
  const reference = (later[0].content as Array<{ text?: string }>)[1]?.text ?? '';
  assertStringIncludes(reference, 'att_provider_file');
  assertStringIncludes(reference, 'view_attachment');
});
