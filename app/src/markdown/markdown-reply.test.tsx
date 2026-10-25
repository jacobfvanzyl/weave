// The fake agent's `/markdown` reply (WVE-128), recorded from a dev Host into
// `src/chat/fixtures/journals/markdown.json`, as the app renders it.
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageResponse } from '@/components/ai-elements/message';
import recording from '@/chat/fixtures/journals/markdown.json';

/** The reply's text, joined from the chunks it streamed in. */
const reply = recording.events
  .flatMap(({ event }) => (event.kind === 'update' && event.notification?.update.sessionUpdate === 'agent_message_chunk'
    ? [event.notification.update.content]
    : []))
  .map((content) => (content && 'text' in content ? content.text : ''))
  .join('');

describe("the fake agent's /markdown reply", () => {
  it('typesets its math and leaves its money, shell variable and inline display as text', () => {
    const { container } = render(<MessageResponse>{reply}</MessageResponse>);
    expect(container.querySelectorAll('.katex-display')).toHaveLength(3);
    expect(container.querySelectorAll('.katex')).toHaveLength(6);
    expect(container).toHaveTextContent('Not math: it costs $5 and $10, and $HOME is your home directory.');
    expect(container).toHaveTextContent('A matrix, $$\\begin{pmatrix}');
  });
});
