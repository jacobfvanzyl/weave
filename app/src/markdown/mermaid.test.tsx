import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageResponse } from '@/components/ai-elements/message';
import { inertSvg } from './mermaid';

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));

/** What Mermaid's sanitizing can let through, as `strict` does images in labels. */
const DRAWN = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" id="d">
  <style>.node{fill:url(https://attacker.example/f.svg)} .edge{marker-end:url(#arrow)}</style>
  <a xlink:href="https://attacker.example/click"><g class="node"><text>Host</text></g></a>
  <image href="https://attacker.example/p.png"></image>
  <image href="data:image/png;base64,AA=="></image>
  <use href="https://attacker.example/s.svg#x"></use><use href="#arrow"></use>
  <foreignObject><div>html</div></foreignObject>
  <rect onclick="alert(1)" style="fill: url('https://attacker.example/r')"></rect>
</svg>`;

describe('inertSvg', () => {
  it('keeps a diagram from running, fetching or navigating', () => {
    const svg = inertSvg(DRAWN);
    expect(svg).toContain('<text>Host</text>');
    expect(svg).not.toContain('attacker.example');
    expect(svg).not.toMatch(/<a[\s>]|foreignObject|onclick/i);
    expect(svg).toContain('data:image/png;base64,AA==');
    expect(svg).toContain('href="#arrow"');
    expect(svg).toContain('url(#arrow)');
  });
});

describe('Mermaid in agent text', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mermaid.render.mockReset();
  });

  it('draws with settings a diagram cannot change, and shows only the inert drawing', async () => {
    mermaid.render.mockResolvedValue({ svg: DRAWN });
    const { container } = render(<MessageResponse>{'```mermaid\nflowchart LR\n  A[Host] --> B\n```'}</MessageResponse>);
    await waitFor(() => expect(container.querySelector('[data-streamdown="mermaid"] svg')).toBeInTheDocument());
    expect(container.querySelector('[data-streamdown="mermaid"] a')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain('attacker.example');
    expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), 'flowchart LR\n  A[Host] --> B\n');
    const settings = mermaid.initialize.mock.calls[0][0];
    expect(settings).toMatchObject({ securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false }, theme: 'base' });
    expect(settings.secure).toEqual(expect.arrayContaining(['securityLevel', 'htmlLabels', 'theme', 'themeVariables', 'themeCSS', 'fontFamily']));
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();
  });

  it('shows the source of a diagram Mermaid cannot draw', async () => {
    mermaid.render.mockRejectedValue(new Error('Parse error on line 2'));
    const { container } = render(<MessageResponse>{'```mermaid\nflowchart LR\n  A[Unclosed --> B\n```'}</MessageResponse>);
    await waitFor(() => expect(screen.getByText("Mermaid couldn't draw this diagram.")).toBeInTheDocument());
    expect(container.querySelector('[data-slot="mermaid-source"] pre')).toHaveTextContent('A[Unclosed --> B');
  });
});
