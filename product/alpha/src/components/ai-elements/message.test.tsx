import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageResponse } from './message';

describe('MessageResponse', () => {
  it('renders streaming markdown and repairs an incomplete code fence', () => {
    const { container, rerender } = render(
      <MessageResponse mode="streaming">{'A **split'}</MessageResponse>,
    );

    rerender(
      <MessageResponse mode="streaming">
        {'A **split message**\n\n```ts\nconst answer = 42;'}
      </MessageResponse>,
    );

    expect(screen.getByText('split message')).toBeInTheDocument();
    expect(screen.getByText('const answer = 42;')).toBeInTheDocument();
    expect(container.querySelector('code')).toHaveTextContent('const answer = 42;');
  });

  it('sanitizes unsafe markup while preserving safe links and long content', () => {
    const longWord = 'a'.repeat(512);
    const { container } = render(
      <MessageResponse>
        {`${longWord}\n\n[safe](https://example.com)\n\n[unsafe](javascript:alert(1))\n\n<script>window.bad = true</script>`}
      </MessageResponse>,
    );

    expect(screen.getByText(longWord)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'safe' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'unsafe' })).not.toBeInTheDocument();
    expect(screen.getByText(/unsafe/)).toHaveAttribute('title', expect.stringContaining('Blocked URL'));
    expect(container.querySelector('script')).not.toBeInTheDocument();
  });
});
