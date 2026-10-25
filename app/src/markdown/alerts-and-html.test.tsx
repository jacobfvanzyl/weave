import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageResponse } from '@/components/ai-elements/message';

describe('GitHub alerts', () => {
  it('labels each kind and drops its marker', () => {
    const kinds = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'];
    const { container } = render(<MessageResponse>{kinds.map((kind) => `> [!${kind}]\n> About ${kind.toLowerCase()}.`).join('\n\n')}</MessageResponse>);
    const alerts = [...container.querySelectorAll('blockquote[data-alert]')];
    expect(alerts.map((alert) => alert.getAttribute('data-alert'))).toEqual(['note', 'tip', 'important', 'warning', 'caution']);
    expect(alerts.map((alert) => alert.querySelector('[data-slot="alert-label"]')?.textContent)).toEqual(['Note', 'Tip', 'Important', 'Warning', 'Caution']);
    expect(alerts[0]).toHaveTextContent(/^Note\s*About note\.$/);
    expect(container).not.toHaveTextContent('[!');
  });

  it('leaves a quote that only mentions a marker a quote', () => {
    const { container } = render(<MessageResponse>{'> [!NOTE] on the same line\n\n> Plain.'}</MessageResponse>);
    expect(container.querySelector('blockquote[data-alert]')).not.toBeInTheDocument();
    expect(container.querySelectorAll('blockquote')).toHaveLength(2);
  });
});

describe('inline HTML', () => {
  it('renders the HTML agents write in Markdown', () => {
    const { container } = render(
      <MessageResponse>
        {'| Keys | What they do |\n| --- | --- |\n| <kbd>Ctrl</kbd>+<kbd>T</kbd> | Detailed view<br>of tool calls |\n\nH<sub>2</sub>O, x<sup>2</sup>, <ins>new</ins> and <del>old</del>.\n\n<details>\n<summary>More</summary>\n\nHidden **Markdown** inside.\n\n</details>'}
      </MessageResponse>,
    );
    expect([...container.querySelectorAll('kbd')].map((kbd) => kbd.textContent)).toEqual(['Ctrl', 'T']);
    expect(screen.getByRole('cell', { name: /Detailed view/ }).querySelector('br')).toBeInTheDocument();
    for (const tag of ['sub', 'sup', 'ins', 'del']) expect(container.querySelector(tag)).toBeInTheDocument();
    const details = container.querySelector('details');
    expect(details?.querySelector('summary')).toHaveTextContent('More');
    expect(details).toHaveTextContent('Hidden Markdown inside.');
  });

  it('shows any other tag, or an allowed one with attributes, as the text it is', () => {
    const { container } = render(
      <MessageResponse>{'A <b>bold</b> <kbd onclick="x">key</kbd> <iframe src="https://example.com"></iframe> <!-- note --> end.'}</MessageResponse>,
    );
    for (const tag of ['b', 'kbd', 'iframe']) expect(container.querySelector(tag)).not.toBeInTheDocument();
    expect(container).toHaveTextContent('A <b>bold</b> <kbd onclick="x">key</kbd> <iframe src="https://example.com"></iframe> <!-- note --> end.');
  });

  it("shows a <details> that isn't closed as text, rather than hide the rest of the message", () => {
    const { container } = render(<MessageResponse>{'<details>\n<summary>More</summary>\n\nThe rest of the message.'}</MessageResponse>);
    expect(container.querySelector('details')).not.toBeInTheDocument();
    expect(container).toHaveTextContent('<details> <summary>More</summary>');
    expect(container).toHaveTextContent('The rest of the message.');
  });
});
