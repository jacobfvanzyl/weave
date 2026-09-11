import { render, screen, act } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ThreadAttention } from '@weave/product-protocol';
import { AgentActivityIndicator } from './agent-activity-indicator';

afterEach(() => vi.useRealTimers());
const attention = (state: ThreadAttention['state'], uncertaintyReason?: ThreadAttention['uncertaintyReason']): ThreadAttention => ({ state, uncertaintyReason, observedAt: new Date().toISOString() });

it('shows themed activity dots with accessible descriptions and a selected-tile outline', () => {
  const view = render(<></>);
  for (const [state, label, color] of [
    ['working', 'Working', 'bg-info'],
    ['waiting', 'Waiting for your input', 'bg-warning'],
    ['completed', 'Turn finished', 'bg-success'],
    ['uncertain', 'Interrupted — outcome unknown', 'bg-destructive'],
  ] as const) {
    view.rerender(<button aria-label='Agent' aria-describedby='activity'><AgentActivityIndicator id='activity' attention={attention(state, state === 'uncertain' ? 'prompt_outcome_unknown' : undefined)} available selected /></button>);
    const dot = screen.getByRole('img', { name: label });
    expect(dot).toHaveAttribute('title', label);
    expect(dot).toHaveClass('size-1.5', 'ring-primary-foreground');
    expect(dot.firstElementChild).toHaveClass(color);
    expect(dot.firstElementChild?.classList.contains('motion-safe:animate-pulse')).toBe(state === 'working');
    expect(screen.getByRole('button', { name: 'Agent' })).toHaveAccessibleDescription(label);
    expect(dot).toHaveTextContent('');
  }
});

it('hides inactive, disconnected, stale, and ambiguous legacy observations', () => {
  const view = render(<></>);
  for (const observation of [undefined, attention('idle'), attention('unavailable'), attention('uncertain'), attention('uncertain', 'runtime_not_loaded'), { ...attention('working'), observedAt: 'invalid' }, { ...attention('completed'), observedAt: new Date(Date.now() - 15_001).toISOString() }]) {
    view.rerender(<AgentActivityIndicator attention={observation} available selected={false} />);
    expect(view.container).toBeEmptyDOMElement();
  }
  view.rerender(<AgentActivityIndicator attention={attention('waiting')} available={false} selected={false} />);
  expect(view.container).toBeEmptyDOMElement();
});

it('expires activity without another snapshot and refreshes from a new observation', () => {
  vi.useFakeTimers();
  const view = render(<AgentActivityIndicator attention={attention('working')} available selected={false} />);
  expect(screen.getByRole('img')).not.toHaveClass('ring-1');
  act(() => vi.advanceTimersByTime(15_001));
  expect(view.container).toBeEmptyDOMElement();
  view.rerender(<AgentActivityIndicator attention={attention('waiting')} available selected={false} />);
  expect(screen.getByRole('img')).toHaveAccessibleName('Waiting for your input');
});
