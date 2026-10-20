import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Reasoning, ReasoningContent, ReasoningTrigger } from './reasoning';

describe('Reasoning', () => {
  it('keeps the user-selected disclosure state while streaming updates arrive', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <Reasoning isStreaming>
        <ReasoningTrigger>Thinking</ReasoningTrigger>
        <ReasoningContent>First thought chunk</ReasoningContent>
      </Reasoning>,
    );

    await user.click(screen.getByRole('button', { name: 'Thinking' }));
    expect(screen.queryByText('First thought chunk')).not.toBeInTheDocument();

    rerender(
      <Reasoning isStreaming>
        <ReasoningTrigger>Thinking</ReasoningTrigger>
        <ReasoningContent>First thought chunk. Second chunk.</ReasoningContent>
      </Reasoning>,
    );

    expect(screen.queryByText('First thought chunk. Second chunk.')).not.toBeInTheDocument();
  });

  it('uses reduced-motion-safe disclosure transitions', () => {
    const { container } = render(
      <Reasoning>
        <ReasoningTrigger>Thinking</ReasoningTrigger>
        <ReasoningContent>Durable thought</ReasoningContent>
      </Reasoning>,
    );

    expect(container.querySelector('[data-slot="reasoning-content"]'))
      .toHaveClass('motion-reduce:transition-none');
  });

  it('marks streaming completion without overriding the disclosure choice', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <Reasoning isStreaming>
        <ReasoningTrigger>Thinking</ReasoningTrigger>
        <ReasoningContent>Split thought</ReasoningContent>
      </Reasoning>,
    );

    const trigger = screen.getByRole('button', { name: 'Thinking' });
    expect(trigger).toHaveAttribute('data-streaming', 'true');
    await user.click(trigger);
    rerender(
      <Reasoning isStreaming={false}>
        <ReasoningTrigger>Thinking</ReasoningTrigger>
        <ReasoningContent>Split thought. Complete.</ReasoningContent>
      </Reasoning>,
    );

    expect(trigger).not.toHaveAttribute('data-streaming');
    expect(screen.queryByText('Split thought. Complete.')).not.toBeInTheDocument();
  });

  it('restores the accepted open presentation after a reload', () => {
    const first = render(
      <Reasoning>
        <ReasoningTrigger>Thinking</ReasoningTrigger>
        <ReasoningContent>Reloaded thought</ReasoningContent>
      </Reasoning>,
    );
    first.unmount();

    render(
      <Reasoning>
        <ReasoningTrigger>Thinking</ReasoningTrigger>
        <ReasoningContent>Reloaded thought</ReasoningContent>
      </Reasoning>,
    );

    expect(screen.getByText('Reloaded thought')).toBeVisible();
  });
});
