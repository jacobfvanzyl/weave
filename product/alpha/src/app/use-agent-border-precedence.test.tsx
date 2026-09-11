import { act, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAgentBorderPrecedence } from './use-agent-border-precedence';

afterEach(() => vi.restoreAllMocks());

it.each(['right', 'left'] as const)('with %s dock gives only the touching focused terminal edge precedence and follows layout changes', async (dock) => {
  let bounds = new DOMRect(0, 32, 500, 468);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.slot !== 'terminal-focus-border') return new DOMRect(500, 0, 400, 600);
    return dock === 'right' ? bounds : new DOMRect(1400 - bounds.right, bounds.top, bounds.width, bounds.height);
  });
  function Harness() {
    useAgentBorderPrecedence();
    return <div id='terminal-agent-layout' data-agent-seam='overlap' data-agent-dock={dock}>
      <section data-focused='true'><div data-slot='terminal-focus-border' style={{ borderTopRightRadius: '6px', borderBottomRightRadius: '6px', borderTopLeftRadius: '6px', borderBottomLeftRadius: '6px' }} /></section>
      <div data-slot='thread-pane' data-testid='agent' />
    </div>;
  }
  const view = render(<Harness />);
  const agent = view.getByTestId('agent');
  await waitFor(() => expect(agent.style.getPropertyValue('--agent-border-mask')).toContain('transparent 38px 494px'));
  expect(agent.style.getPropertyValue('--agent-border-offset')).toBe(dock === 'left' ? '1px' : '-1px');
  // A lower split only owns its own vertical interval.
  act(() => { bounds = new DOMRect(0, 300, 501, 200); window.dispatchEvent(new Event('resize')); });
  await waitFor(() => expect(agent.style.getPropertyValue('--agent-border-mask')).toContain('transparent 306px 494px'));
  expect(agent.style.getPropertyValue('--agent-border-offset')).toBe('0px');
  // Focus elsewhere in the workspace must restore the mauve edge.
  act(() => { bounds = new DOMRect(0, 300, 250, 200); window.dispatchEvent(new Event('resize')); });
  await waitFor(() => expect(agent.style.getPropertyValue('--agent-border-mask')).toBe(''));
  expect(agent.style.getPropertyValue('--agent-border-offset')).toBe('');
  act(() => { bounds = new DOMRect(0, 32, 501, 468); window.dispatchEvent(new Event('resize')); });
  await waitFor(() => expect(agent.style.getPropertyValue('--agent-border-mask')).not.toBe(''));
  act(() => { document.getElementById('terminal-agent-layout')!.removeAttribute('data-agent-seam'); });
  await waitFor(() => expect(agent.style.getPropertyValue('--agent-border-mask')).toBe(''));
  view.unmount();
});
